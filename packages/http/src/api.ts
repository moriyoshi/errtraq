import {
  type ActiveStore,
  type ApiToken,
  type BlobStore,
  type Clock,
  type Cursor,
  type EventId,
  hashApiToken,
  InvalidCursorError,
  type Issue,
  type IssueId,
  type IssueStatus,
  type Logger,
  NotFoundError,
  type Project,
  type StoredEvent,
  UnsupportedQueryError,
  VersionConflictError,
} from "@errtraq/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { eventJson, issueJson } from "./api-mappers.js";
import { logUnexpected } from "./errors.js";

type Env = { Variables: { token: ApiToken } };
const statuses = ["unresolved", "resolved", "ignored"] as const;
/** Minimal Sentry-compatible project and issue API; every resource is scoped to the token organization. */
export function createApiApp(options: {
  store: ActiveStore;
  clock: Clock;
  blobs?: BlobStore;
  logger?: Pick<Logger, "error">;
}): Hono<Env> {
  const app = new Hono<Env>({ strict: false });
  const { store, clock } = options;
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
  async function renderIssue(issue: Issue, origin: string) {
    const project = await store.projects.get(issue.projectId);
    const org = project && (await store.projects.getOrg(project.orgId));
    if (!project || !org)
      throw new Error("Issue project or organization missing");
    const event = await store.events.get(issue.projectId, issue.lastEventId);
    return issueJson(
      issue,
      project,
      org,
      origin,
      event ? await payloadOf(event) : {},
    );
  }
  app.onError((error, c) => {
    if (error instanceof HTTPException && error.status < 500)
      return error.getResponse();
    if (
      error instanceof UnsupportedQueryError ||
      error instanceof InvalidCursorError
    )
      return c.json({ detail: error.message }, 400);
    if (error instanceof NotFoundError)
      return c.json({ detail: "Not found" }, 404);
    if (error instanceof VersionConflictError)
      return c.json({ detail: "Conflict, please retry" }, 409);
    const requestId = logUnexpected(options.logger, error, c.req.raw);
    return c.json({ detail: "Internal server error", requestId }, 500);
  });
  app.use("/api/0/*", async (c, next) => {
    const auth = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i);
    if (!auth?.[1]) return c.json({ detail: "Authentication required" }, 401);
    const token = await store.projects.getTokenByHash(
      await hashApiToken(auth[1]),
    );
    if (!token || token.revokedAt)
      return c.json({ detail: "Invalid token" }, 401);
    const required = ["PUT", "POST", "PATCH", "DELETE"].includes(c.req.method)
      ? "event:write"
      : "event:read";
    if (!token.scopes.includes(required))
      return c.json({ detail: "Insufficient scope" }, 403);
    c.set("token", token);
    await next();
  });
  async function project(
    orgSlug: string,
    slug: string,
    token: ApiToken,
  ): Promise<Project | null> {
    const org = await store.projects.getOrgBySlug(orgSlug);
    if (!org || org.id !== token.orgId) return null;
    return store.projects.getProjectBySlug(org.id, slug);
  }
  async function scopedIssue(
    id: string,
    token: ApiToken,
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
    const url = new URL(c.req.url);
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
    const page = await store.issues.list({
      projectId: p.id,
      status: status as IssueStatus | undefined,
      sort: sort as "lastSeen" | "firstSeen" | "count",
      cursor: (c.req.query("cursor") || undefined) as Cursor | undefined,
      limit: size(c.req.query("limit") ?? c.req.query("per_page")),
    });
    link(c, page.nextCursor);
    return c.json(
      await Promise.all(
        page.items.map((issue) =>
          renderIssue(issue, new URL(c.req.url).origin),
        ),
      ),
    );
  }
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
      ids[0] as import("@errtraq/core").ProjectId,
    );
    if (!p || p.orgId !== org.id) return c.json({ detail: "Not found" }, 404);
    return listIssues(c, p, true);
  });
  app.get("/api/0/issues/:id", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    return issue
      ? c.json(await renderIssue(issue, new URL(c.req.url).origin))
      : c.json({ detail: "Not found" }, 404);
  });
  app.put("/api/0/issues/:id", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
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
    const status = (input as { status: IssueStatus }).status;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const updated = await store.issues.update(issue.projectId, issue.id, {
          status,
          ...(status === "resolved"
            ? { resolvedAt: clock.now() }
            : { resolvedAt: undefined }),
        });
        return c.json(await renderIssue(updated, new URL(c.req.url).origin));
      } catch (error) {
        if (!(error instanceof VersionConflictError) || attempt === 2)
          throw error;
      }
    }
    throw new VersionConflictError("Conflict");
  });
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
    const page = await store.events.listByIssue({
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
    const event = await store.events.get(issue.projectId, issue.lastEventId);
    return event
      ? c.json(await renderEvent(event, issue))
      : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/issues/:id/events/:event", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const event = await store.events.get(
      issue.projectId,
      c.req.param("event") as EventId,
    );
    return event && event.issueId === issue.id
      ? c.json(await renderEvent(event, issue))
      : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/projects/:org/:project/events/:event", async (c) => {
    const p = await project(
      c.req.param("org"),
      c.req.param("project"),
      c.get("token"),
    );
    if (!p) return c.json({ detail: "Not found" }, 404);
    const event = await store.events.get(p.id, c.req.param("event") as EventId);
    if (!event) return c.json({ detail: "Not found" }, 404);
    const issue = await store.issues.get(p.id, event.issueId);
    return issue
      ? c.json(await renderEvent(event, issue))
      : c.json({ detail: "Not found" }, 404);
  });
  return app;
}
