import {
  type ActiveStore,
  type ApiToken,
  type BlobStore,
  type Clock,
  type Cursor,
  decodeCursor,
  type EventId,
  type EventPosition,
  encodeCursor,
  hashApiToken,
  InvalidCursorError,
  type Issue,
  type IssueId,
  type IssueStatus,
  NotFoundError,
  type Project,
  type StoredEvent,
  type Timestamp,
  UnsupportedQueryError,
} from "@errtraq/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

type Env = { Variables: { token: ApiToken } };
const statuses = ["unresolved", "resolved", "ignored"] as const;
function issueJson(issue: Issue) {
  return {
    id: issue.id,
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    type: issue.type,
    metadata: issue.metadata,
    status: issue.status,
    count: String(issue.count),
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    project: { id: issue.projectId },
  };
}
function eventJson(event: StoredEvent) {
  return {
    ...event.payload,
    id: event.eventId,
    eventID: event.eventId,
    groupID: event.issueId,
    dateCreated: event.receivedAt,
    timestamp: event.timestamp,
    level: event.level,
    tags: event.tags,
    user: event.user ?? null,
    release: event.release ?? null,
    environment: event.environment ?? null,
  };
}
/** Minimal Sentry-compatible project and issue API; every resource is scoped to the token organization. */
export function createApiApp(options: {
  store: ActiveStore;
  clock: Clock;
  blobs?: BlobStore;
}): Hono<Env> {
  const app = new Hono<Env>();
  const { store, clock } = options;
  async function renderEvent(event: StoredEvent) {
    if (!event.payloadBlobKey) return eventJson(event);
    if (!options.blobs) throw new Error("Event payload store unavailable");
    const body = await options.blobs.get(event.payloadBlobKey);
    if (!body) throw new Error("Event payload missing");
    const payload: unknown = await new Response(body).json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid stored event payload");
    return eventJson({ ...event, payload: payload as Record<string, unknown> });
  }
  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (
      error instanceof UnsupportedQueryError ||
      error instanceof InvalidCursorError ||
      error instanceof SyntaxError ||
      error instanceof RangeError
    )
      return c.json({ detail: error.message }, 400);
    if (error instanceof NotFoundError)
      return c.json({ detail: "Not found" }, 404);
    return c.json({ detail: "Internal server error" }, 500);
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
  app.get("/api/0/projects/:org/:project/issues/", async (c) => {
    allowed(c, ["status", "sort", "cursor", "limit"]);
    const p = await project(
      c.req.param("org"),
      c.req.param("project"),
      c.get("token"),
    );
    if (!p) return c.json({ detail: "Not found" }, 404);
    const status = c.req.query("status");
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
      cursor: c.req.query("cursor") as Cursor | undefined,
      limit: size(c.req.query("limit")),
    });
    link(c, page.nextCursor);
    return c.json(page.items.map(issueJson));
  });
  app.get("/api/0/issues/:id/", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    return issue
      ? c.json(issueJson(issue))
      : c.json({ detail: "Not found" }, 404);
  });
  app.put("/api/0/issues/:id/", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const input: unknown = await c.req.json();
    if (
      !input ||
      typeof input !== "object" ||
      !statuses.includes((input as { status: IssueStatus }).status)
    )
      return c.json({ detail: "Invalid status" }, 400);
    const status = (input as { status: IssueStatus }).status;
    const updated = await store.issues.update(issue.projectId, issue.id, {
      status,
      ...(status === "resolved"
        ? { resolvedAt: clock.now() }
        : { resolvedAt: undefined }),
    });
    return c.json(issueJson(updated));
  });
  app.get("/api/0/issues/:id/events/", async (c) => {
    allowed(c, ["cursor", "limit"]);
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const scope = `issue-events:${issue.projectId}:${issue.id}`;
    const keys = decodeCursor(
      c.req.query("cursor") as Cursor | undefined,
      scope,
    );
    if (
      keys &&
      (keys.length !== 2 ||
        typeof keys[0] !== "string" ||
        typeof keys[1] !== "string")
    )
      throw new InvalidCursorError("Invalid event cursor");
    const after = keys
      ? ({
          receivedAt: keys[0] as Timestamp,
          eventId: keys[1] as EventId,
        } satisfies EventPosition)
      : undefined;
    const page = await store.events.listByIssue({
      projectId: issue.projectId,
      issueId: issue.id,
      order: "desc",
      after,
      limit: size(c.req.query("limit")),
    });
    const last = page.items.at(-1);
    link(
      c,
      page.hasMore && last
        ? encodeCursor(scope, [last.receivedAt, last.eventId])
        : null,
    );
    return c.json(await Promise.all(page.items.map(renderEvent)));
  });
  app.get("/api/0/issues/:id/events/latest/", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const event = await store.events.get(issue.projectId, issue.lastEventId);
    return event
      ? c.json(await renderEvent(event))
      : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/issues/:id/events/:event/", async (c) => {
    const issue = await scopedIssue(c.req.param("id"), c.get("token"));
    if (!issue) return c.json({ detail: "Not found" }, 404);
    const event = await store.events.get(
      issue.projectId,
      c.req.param("event") as EventId,
    );
    return event && event.issueId === issue.id
      ? c.json(await renderEvent(event))
      : c.json({ detail: "Not found" }, 404);
  });
  app.get("/api/0/projects/:org/:project/events/:event/", async (c) => {
    const p = await project(
      c.req.param("org"),
      c.req.param("project"),
      c.get("token"),
    );
    if (!p) return c.json({ detail: "Not found" }, 404);
    const event = await store.events.get(p.id, c.req.param("event") as EventId);
    return event
      ? c.json(await renderEvent(event))
      : c.json({ detail: "Not found" }, 404);
  });
  return app;
}
