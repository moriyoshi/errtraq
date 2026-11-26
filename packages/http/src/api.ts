import {
  type ActiveStore,
  type ArchiveStore,
  ArtifactBundleService,
  type AuthSettings,
  type BlobStore,
  type ChunkUploadLimits,
  type Clock,
  ConflictError,
  type Cursor,
  type EventId,
  EventQueryService,
  type FacetKey,
  type IdGen,
  InvalidCursorError,
  InvalidIdentifierError,
  type Issue,
  type IssueId,
  type IssueStatus,
  isFacetKey,
  type KV,
  type Logger,
  MAX_FACET_TOP_VALUES,
  NotFoundError,
  type Project,
  parseAuthSettings,
  type RateRejectionConfig,
  rateRejectionEnabled,
  readDropped,
  type StoredEvent,
  UnsupportedQueryError,
  VersionConflictError,
  WebCryptoIdGen,
} from "@moriyoshi/errtraq-core/runtime";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { ApiEnv } from "./api-env.js";
import {
  eventJson,
  issueJson,
  keyJson,
  orgJson,
  projectJson,
} from "./api-mappers.js";
import { createAuthenticator, csrfAllowed, type Principal } from "./auth.js";
import { logUnexpected } from "./errors.js";
import type { FetchLike } from "./jwt.js";
import { publicApiOrigin, publicRequestUrl } from "./public-url.js";
import { addReleaseRoutes } from "./release-routes.js";
import {
  facetJson,
  LIST_STATS_PERIODS,
  type PeriodWindow,
  periodWindow,
  type StatsPeriod,
  storeRange,
  tagValueJson,
  zeroFill,
} from "./stats.js";

type Env = ApiEnv;
const statuses = ["unresolved", "resolved", "ignored"] as const;
const MAX_EMPTY_PAGES = 20;
/** Exact origins only: no wildcard, no path. */
function corsOrigin(value: string): string {
  let origin: string | undefined;
  try {
    origin = new URL(value).origin;
  } catch {
    // fall through to the error
  }
  if (value === "*" || !origin || origin === "null" || origin !== value)
    throw new Error(`Invalid CORS origin: ${value}`);
  return origin;
}
/** Minimal Sentry-compatible project and issue API; every resource is scoped to the token organization. */
export function createApiApp(options: {
  store: ActiveStore;
  clock: Clock;
  blobs?: BlobStore;
  kv?: KV;
  rateRejection?: RateRejectionConfig;
  logger?: Pick<Logger, "error">;
  ids?: IdGen;
  /** Chunk upload limits advertised to sentry-cli and enforced during assembly. */
  chunkUpload?: Partial<ChunkUploadLimits>;
  /** Second event tier; absent means events are read from the active store only. */
  archive?: ArchiveStore;
  /**
   * Public ingest origin used to build DSNs in the key list. API and ingest can be served from
   * different hosts, so without it the key list carries no `dsn` instead of guessing one.
   */
  ingestUrl?: string;
  /**
   * Public origin of the API (`https://errtraq.example.com`) for the absolute URLs it builds:
   * `Link` headers, issue permalinks and the chunk-upload endpoint. Behind a CDN the request URL
   * is the function URL host. Configuration only, never a request header. Absent, the request URL.
   */
  publicApiUrl?: string;
  /** Cross-origin browser access for a UI hosted elsewhere; off by default. Exact origins only. */
  cors?: { origins: string[]; maxAgeSec?: number };
  /** OIDC Bearer JWTs and identity-aware proxy principals, next to API tokens; off when absent. */
  auth?: AuthSettings;
  /** Fetch used for JWKS and discovery; defaults to the global `fetch`. For tests. */
  authFetch?: FetchLike;
}): Hono<Env> {
  const publicOrigin = publicApiOrigin(options.publicApiUrl);
  const app = new Hono<Env>({ strict: false });
  const { store, clock } = options;
  const events = new EventQueryService({
    store,
    ...(options.archive ? { archive: options.archive } : {}),
  });
  if (rateRejectionEnabled(options.rateRejection) && !options.kv)
    throw new Error("Rate rejection API requires KV");
  async function payloadOf(
    event: StoredEvent,
  ): Promise<Record<string, unknown>> {
    if (!event.payloadBlobKey) return event.payload;
    if (!options.blobs) throw new Error("Event payload store unavailable");
    const body = await options.blobs.get(event.payloadBlobKey);
    if (!body) throw new Error("Event payload missing");
    let payload: unknown;
    try {
      payload = await new Response(body).json();
    } catch {
      throw new Error("Invalid stored event payload");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid stored event payload");
    return payload as Record<string, unknown>;
  }
  async function renderEvent(event: StoredEvent, issue: Issue) {
    return eventJson(event, issue, await payloadOf(event));
  }
  /**
   * The first event of an issue in `order`, strictly after `after` when given. A source page may
   * be empty and still carry a continuation, so the walk follows it, at most MAX_EMPTY_PAGES
   * times; running out of that budget reads as "no neighbour" rather than scanning on.
   */
  async function firstEvent(
    issue: Issue,
    order: "asc" | "desc",
    after?: StoredEvent,
  ): Promise<StoredEvent | null> {
    let cursor: Cursor | undefined;
    for (let page = 0; page < MAX_EMPTY_PAGES; page++) {
      const result = await events.listByIssue({
        projectId: issue.projectId,
        issueId: issue.id,
        order,
        limit: 1,
        // A continuation cursor replaces `after`; the two are exclusive.
        ...(cursor
          ? { cursor }
          : after
            ? {
                after: { receivedAt: after.receivedAt, eventId: after.eventId },
              }
            : {}),
      });
      const [item] = result.items;
      if (item) return item;
      if (!result.nextCursor) return null;
      cursor = result.nextCursor;
    }
    return null;
  }
  /** Single-event response with Sentry's neighbours; previous is older, next is newer. */
  async function renderEventWithNeighbours(event: StoredEvent, issue: Issue) {
    const [previous, next] = await Promise.all([
      firstEvent(issue, "desc", event),
      firstEvent(issue, "asc", event),
    ]);
    return {
      ...(await renderEvent(event, issue)),
      previousEventID: previous?.eventId ?? null,
      nextEventID: next?.eventId ?? null,
    };
  }
  /** The statistics repo, or the 400 a store without the capability gives. */
  function statsRepo(
    capability: "issueStats" | "tagFacets",
  ): NonNullable<ActiveStore["stats"]> {
    if (!store.stats || !store.capabilities[capability])
      throw new UnsupportedQueryError(
        capability === "issueStats"
          ? "Issue statistics are not supported by this store"
          : "Tag facets are not supported by this store",
      );
    return store.stats;
  }
  /** `statsPeriod` on the issue list: absent or empty means none; 24h and 14d only. */
  function listStatsPeriod(value: string | undefined): StatsPeriod | undefined {
    if (value === undefined || value === "") return undefined;
    if (!(LIST_STATS_PERIODS as readonly string[]).includes(value))
      throw new UnsupportedQueryError(
        `Unsupported statsPeriod: ${value} (use 24h or 14d)`,
      );
    statsRepo("issueStats");
    return value as StatsPeriod;
  }
  async function issueSeries(
    projectId: Issue["projectId"],
    issueIds: IssueId[],
    windows: PeriodWindow[],
  ) {
    const rows = await statsRepo("issueStats").series(
      projectId,
      issueIds,
      storeRange(windows),
    );
    return new Map(
      rows.map((row) => [
        row.issueId,
        Object.fromEntries(
          windows.map((w) => [w.period, zeroFill(row.buckets, w)]),
        ),
      ]),
    );
  }
  async function renderIssue(issue: Issue, origin: string) {
    const project = await store.projects.get(issue.projectId);
    const org = project && (await store.projects.getOrg(project.orgId));
    if (!project || !org)
      throw new Error("Issue project or organization missing");
    const event = await events.getEvent(
      issue.projectId,
      issue.lastEventId,
      issue.lastEventReceivedAt,
    );
    const result = issueJson(
      issue,
      project,
      org,
      origin,
      event ? await payloadOf(event) : {},
    );
    if (!options.kv || !rateRejectionEnabled(options.rateRejection))
      return result;
    const now = clock.now();
    const dropped = await readDropped(
      options.kv,
      options.rateRejection,
      issue.projectId,
      issue.id,
      now,
    );
    if (!dropped) return result;
    const start =
      Math.floor(Date.parse(now) / (dropped.windowSec * 1000)) *
      dropped.windowSec *
      1000;
    return {
      ...result,
      approximateDropped: {
        ...dropped,
        windowStart: new Date(start).toISOString(),
        windowEnd: new Date(start + dropped.windowSec * 1000).toISOString(),
        timeBasis: "receivedAt" as const,
      },
    };
  }
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status < 500)
      return error.getResponse();
    if (
      error instanceof UnsupportedQueryError ||
      error instanceof InvalidCursorError ||
      error instanceof InvalidIdentifierError
    )
      return c.json({ detail: error.message }, 400);
    if (error instanceof NotFoundError)
      return c.json({ detail: "Not found" }, 404);
    if (error instanceof VersionConflictError)
      return c.json({ detail: "Conflict, please retry" }, 409);
    if (error instanceof ConflictError)
      return c.json({ detail: "Conflict, please retry" }, 409);
    const requestId = logUnexpected(options.logger, error, c.req.raw);
    return c.json({ detail: "Internal server error", requestId }, 500);
  });
  // The stack config supplies these origins: standalone passes them here, while on Lambda the
  // function URL's CORS block carries the policy (so the app must not duplicate it).
  if (options.cors) {
    const origins = options.cors.origins.map(corsOrigin);
    if (origins.length === 0) throw new Error("CORS origins must not be empty");
    // Registered before the auth middleware: a preflight carries no token.
    app.use(
      "/api/0/*",
      cors({
        origin: origins,
        allowMethods: ["GET", "PUT", "POST", "OPTIONS"],
        allowHeaders: ["Authorization", "Content-Type"],
        exposeHeaders: ["Link"],
        maxAge: options.cors.maxAgeSec ?? 86400,
      }),
    );
  }
  const authenticate = createAuthenticator({
    store,
    now: () => Math.floor(Date.parse(clock.now()) / 1000),
    ...(options.auth ? { settings: parseAuthSettings(options.auth) } : {}),
    ...(options.authFetch ? { fetch: options.authFetch } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  app.use("/api/0/*", async (c, next) => {
    const result = await authenticate(c.req.raw);
    if (!result.ok) return c.json({ detail: result.detail }, result.status);
    const principal = result.principal;
    const write = ["PUT", "POST", "PATCH", "DELETE"].includes(c.req.method);
    const required = write ? "event:write" : "event:read";
    // TODO(UI-f): finer `org:read` / `project:read` requirements; existing API tokens carry only
    // `event:*` scopes, so changing the requirements here would lock them out.
    if (!principal.scopes.includes(required))
      return c.json({ detail: "Insufficient scope" }, 403);
    // A proxy principal rides a session cookie, so writes need the CSRF header.
    if (principal.kind === "proxy" && !csrfAllowed(c.req.raw))
      return c.json({ detail: "CSRF check failed" }, 403);
    c.set("token", principal);
    await next();
  });
  async function project(
    orgSlug: string,
    slug: string,
    token: Principal,
  ): Promise<Project | null> {
    const org = await store.projects.getOrgBySlug(orgSlug);
    if (!org || org.id !== token.orgId) return null;
    return store.projects.getProjectBySlug(org.id, slug);
  }
  async function scopedIssue(
    id: string,
    token: Principal,
  ): Promise<Issue | null> {
    const issues = await store.issues.getById(id as IssueId);
    const visible: Issue[] = [];
    for (const issue of issues) {
      const owner = await store.projects.get(issue.projectId);
      if (owner?.orgId === token.orgId) visible.push(issue);
    }
    if (visible.length > 1)
      throw new HTTPException(409, { message: "Ambiguous issue ID" });
    return visible[0] ?? null;
  }
  function allowed(c: import("hono").Context<Env>, valid: string[]) {
    const unexpected = Object.keys(c.req.query()).find(
      (key) => !valid.includes(key),
    );
    if (unexpected)
      throw new UnsupportedQueryError(`Unsupported filter: ${unexpected}`);
  }
  function size(value: string | undefined) {
    if (value === undefined) return 100;
    if (!/^\d+$/.test(value))
      throw new InvalidCursorError("Invalid page limit");
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > 100)
      throw new InvalidCursorError("Invalid page limit");
    return n;
  }
  function link(c: import("hono").Context<Env>, next: string | null) {
    const url = publicRequestUrl(c.req.url, publicOrigin);
    if (next) url.searchParams.set("cursor", next);
    else url.searchParams.delete("cursor");
    c.header(
      "Link",
      `<${url.toString()}>; rel="previous"; results="false"; cursor="", <${url.toString()}>; rel="next"; results="${next ? "true" : "false"}"; cursor="${next ?? ""}"`,
    );
  }
  async function listIssues(
    c: import("hono").Context<Env>,
    p: Project,
    organizationRoute = false,
  ) {
    allowed(c, [
      "status",
      "sort",
      "cursor",
      "limit",
      "per_page",
      "query",
      "statsPeriod",
      "expand",
      "collapse",
      "shortIdLookup",
      ...(organizationRoute ? ["project"] : []),
    ]);
    let status = c.req.query("status");
    const query = c.req.query("query")?.trim() ?? "";
    for (const term of query ? query.split(/\s+/) : []) {
      const match = /^is:(unresolved|resolved|ignored)$/.exec(term);
      if (!match?.[1])
        throw new UnsupportedQueryError(`Unsupported query: ${term}`);
      if (status && status !== match[1])
        throw new UnsupportedQueryError(`Conflicting status: ${term}`);
      status = match[1];
    }
    const requestedSort = c.req.query("sort") ?? "lastSeen";
    const sort =
      (
        { date: "lastSeen", new: "firstSeen", freq: "count" } as Record<
          string,
          string
        >
      )[requestedSort] ?? requestedSort;
    if (status && !statuses.includes(status as IssueStatus))
      throw new UnsupportedQueryError("Unsupported status");
    if (!["lastSeen", "firstSeen", "count"].includes(sort))
      throw new UnsupportedQueryError("Unsupported sort");
    const statsPeriod = listStatsPeriod(c.req.query("statsPeriod"));
    const page = await store.issues.list({
      projectId: p.id,
      status: status as IssueStatus | undefined,
      sort: sort as "lastSeen" | "firstSeen" | "count",
      cursor: (c.req.query("cursor") || undefined) as Cursor | undefined,
      limit: size(c.req.query("limit") ?? c.req.query("per_page")),
    });
    link(c, page.nextCursor);
    // One batched statistics call for the whole page.
    const stats = statsPeriod
      ? await issueSeries(
          p.id,
          page.items.map((issue) => issue.id),
          [periodWindow(statsPeriod, Date.parse(clock.now()))],
        )
      : undefined;
    return c.json(
      await Promise.all(
        page.items.map(async (issue) => ({
          ...(await renderIssue(
            issue,
            publicRequestUrl(c.req.url, publicOrigin).origin,
          )),
          ...(stats ? { stats: stats.get(issue.id) ?? {} } : {}),
        })),
      ),
    );
  }
  app.get("/api/0/organizations", async (c) => {
    const org = await store.projects.getOrg(c.get("token").orgId);
    return org ? c.json([orgJson(org)]) : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/organizations/:org", async (c) => {
    const org = await store.projects.getOrgBySlug(c.req.param("org"));
    return org && org.id === c.get("token").orgId
      ? c.json(orgJson(org))
      : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/organizations/:org/projects", async (c) => {
    allowed(c, ["cursor", "limit", "per_page"]);
    const org = await store.projects.getOrgBySlug(c.req.param("org"));
    if (!org || org.id !== c.get("token").orgId)
      return c.json({ detail: "Not found" }, 404);
    // A short or empty page may carry a cursor; it is passed through, not looped over.
    const page = await store.projects.listByOrg(
      org.id,
      (c.req.query("cursor") || undefined) as Cursor | undefined,
      size(c.req.query("limit") ?? c.req.query("per_page")),
    );
    link(c, page.nextCursor);
    return c.json(page.items.map((p) => projectJson(p, org)));
  });
  app.get("/api/0/projects/:org/:project", async (c) => {
    const p = await project(
      c.req.param("org"),
      c.req.param("project"),
      c.get("token"),
    );
    const org = p && (await store.projects.getOrg(p.orgId));
    return p && org
      ? c.json(projectJson(p, org))
      : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/projects/:org/:project/keys", async (c) => {
    const p = await project(
      c.req.param("org"),
      c.req.param("project"),
      c.get("token"),
    );
    if (!p) return c.json({ detail: "Not found" }, 404);
    const keys = await store.projects.listKeys(p.id);
    return c.json(keys.map((key) => keyJson(key, options.ingestUrl)));
  });
  app.get("/api/0/projects/:org/:project/issues", async (c) => {
    const p = await project(
      c.req.param("org"),
      c.req.param("project"),
      c.get("token"),
    );
    return p ? listIssues(c, p) : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/organizations/:org/issues", async (c) => {
    const ids = c.req.queries("project") ?? [];
    if (ids.length !== 1 || !ids[0])
      return c.json({ detail: "Exactly one project is required" }, 400);
    const org = await store.projects.getOrgBySlug(c.req.param("org"));
    if (!org || org.id !== c.get("token").orgId)
      return c.json({ detail: "Not found" }, 404);
    const p = await store.projects.get(
      ids[0] as import("@moriyoshi/errtraq-core").ProjectId,
    );
    if (!p || p.orgId !== org.id) return c.json({ detail: "Not found" }, 404);
    return listIssues(c, p, true);
  });
  // Bulk status update. Every id is validated before the first write, but the writes themselves
  // are independent per-issue CAS updates: a failure part-way returns the error and the issues
  // already written stay written. Sentry's "update everything matching the query" (no `id`) is
  // not supported.
  app.put("/api/0/projects/:org/:project/issues", async (c) => {
    const p = await project(
      c.req.param("org"),
      c.req.param("project"),
      c.get("token"),
    );
    if (!p) return c.json({ detail: "Not found" }, 404);
    allowed(c, ["id"]);
    const requested = c.req.queries("id") ?? [];
    if (requested.length < 1 || requested.length > 100)
      return c.json(
        { detail: "Between 1 and 100 id parameters required" },
        400,
      );
    const status = await statusBody(c);
    if (status instanceof Response) return status;
    const targets: Issue[] = [];
    for (const id of new Set(requested)) {
      const issue = await store.issues.get(p.id, id as IssueId);
      if (!issue) return c.json({ detail: "Not found" }, 404);
      targets.push(issue);
    }
    for (const issue of targets) await updateStatus(issue, status);
    return c.json({ status, statusDetails: {} });
  });
  app.get("/api/0/issues/:id", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const rendered = await renderIssue(
      issue,
      publicRequestUrl(c.req.url, publicOrigin).origin,
    );
    if (!store.stats || !store.capabilities.issueStats) return c.json(rendered);
    const now = Date.parse(clock.now());
    const stats = await issueSeries(
      issue.projectId,
      [issue.id],
      [periodWindow("24h", now), periodWindow("30d", now)],
    );
    return c.json({
      ...rendered,
      stats: stats.get(issue.id) ?? {},
      timeBasis: "receivedAt" as const,
    });
  });
  // Tag facets over a fixed allow-list of keys (never personal data); see IssueStatsRepo.
  app.get("/api/0/issues/:id/tags", async (c) => {
    allowed(c, []);
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const facets = await statsRepo("tagFacets").tagFacets(
      issue.projectId,
      issue.id,
      { limit: MAX_FACET_TOP_VALUES },
    );
    return c.json(facets.map(facetJson));
  });
  app.get("/api/0/issues/:id/tags/:key", async (c) => {
    allowed(c, []);
    const key = c.req.param("key");
    if (!isFacetKey(key)) return c.json({ detail: "Not found" }, 404);
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const facets = await statsRepo("tagFacets").tagFacets(
      issue.projectId,
      issue.id,
      { limit: MAX_FACET_TOP_VALUES },
    );
    return c.json(facetJson(facets.find((f) => f.key === key) ?? { key }));
  });
  app.get("/api/0/issues/:id/tags/:key/values", async (c) => {
    allowed(c, ["cursor", "limit", "per_page"]);
    const key = c.req.param("key");
    if (!isFacetKey(key)) return c.json({ detail: "Not found" }, 404);
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const page = await statsRepo("tagFacets").tagValues(
      issue.projectId,
      issue.id,
      key as FacetKey,
      {
        cursor: (c.req.query("cursor") || undefined) as Cursor | undefined,
        limit: size(c.req.query("limit") ?? c.req.query("per_page")),
      },
    );
    link(c, page.nextCursor);
    return c.json(page.items.map((v) => tagValueJson(key, v)));
  });
  /** The `{ status }` body shared by the single and bulk update; a Response is the 400. */
  async function statusBody(
    c: import("hono").Context<Env>,
  ): Promise<IssueStatus | Response> {
    let input: unknown;
    try {
      input = await c.req.json();
    } catch (error) {
      if (error instanceof SyntaxError)
        return c.json({ detail: "Invalid JSON" }, 400);
      throw error;
    }
    if (
      !input ||
      typeof input !== "object" ||
      !statuses.includes((input as { status: IssueStatus }).status)
    )
      return c.json({ detail: "Invalid status" }, 400);
    return (input as { status: IssueStatus }).status;
  }
  app.put("/api/0/issues/:id", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const status = await statusBody(c);
    if (status instanceof Response) return status;
    return c.json(
      await renderIssue(
        await updateStatus(issue, status),
        publicRequestUrl(c.req.url, publicOrigin).origin,
      ),
    );
  });
  /** Bounded compare-and-set retry; `update` is version-checked inside the store. */
  async function updateStatus(
    issue: Issue,
    status: IssueStatus,
  ): Promise<Issue> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await store.issues.update(issue.projectId, issue.id, {
          status,
          ...(status === "resolved"
            ? { resolvedAt: clock.now() }
            : { resolvedAt: undefined }),
        });
      } catch (error) {
        if (!(error instanceof VersionConflictError) || attempt === 2)
          throw error;
      }
    }
    throw new VersionConflictError("Conflict");
  }
  app.on(
    ["GET", "POST"],
    "/api/0/projects/:org/:project/erasure-requests",
    async (c) => {
      const p = await project(
        c.req.param("org"),
        c.req.param("project"),
        c.get("token"),
      );
      if (!p) return c.json({ detail: "Not found" }, 404);
      return c.json({ detail: "Subject erasure is unavailable until M4" }, 501);
    },
  );
  app.get("/api/0/issues/:id/events", async (c) => {
    allowed(c, ["cursor", "limit"]);
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const page = await events.listByIssue({
      projectId: issue.projectId,
      issueId: issue.id,
      order: "desc",
      cursor: (c.req.query("cursor") || undefined) as Cursor | undefined,
      limit: size(c.req.query("limit")),
    });
    link(c, page.nextCursor);
    return c.json(
      await Promise.all(page.items.map((event) => renderEvent(event, issue))),
    );
  });
  app.get("/api/0/issues/:id/events/latest", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const event = await events.getEvent(
      issue.projectId,
      issue.lastEventId,
      issue.lastEventReceivedAt,
    );
    return event
      ? c.json(await renderEventWithNeighbours(event, issue))
      : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/issues/:id/events/oldest", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const event = await firstEvent(issue, "asc");
    return event
      ? c.json(await renderEventWithNeighbours(event, issue))
      : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/issues/:id/events/:event", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const event = await events.getEvent(
      issue.projectId,
      c.req.param("event") as EventId,
    );
    return event && event.issueId === issue.id
      ? c.json(await renderEventWithNeighbours(event, issue))
      : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/projects/:org/:project/events/:event", async (c) => {
    const p = await project(
      c.req.param("org"),
      c.req.param("project"),
      c.get("token"),
    );
    if (!p) return c.json({ detail: "Not found" }, 404);
    const event = await events.getEvent(p.id, c.req.param("event") as EventId);
    if (!event) return c.json({ detail: "Not found" }, 404);
    const issue = await store.issues.get(p.id, event.issueId);
    return issue
      ? c.json(await renderEventWithNeighbours(event, issue))
      : c.json({ detail: "Not found" }, 404);
  });
  const ids = options.ids ?? new WebCryptoIdGen();
  addReleaseRoutes(app, {
    publicOrigin,
    store,
    clock,
    ids,
    blobs: options.blobs,
    archiveConfigured: options.archive !== undefined,
    bundles: options.blobs
      ? new ArtifactBundleService({
          releases: store.releases,
          blobs: options.blobs,
          clock,
          ids,
          limits: options.chunkUpload,
        })
      : undefined,
  });
  return app;
}
