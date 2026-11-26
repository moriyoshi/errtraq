import {
  type ApiTokenId,
  bootstrapProject,
  type EventId,
  hashApiToken,
  type IssueId,
  type OrgId,
  type Page,
  type Project,
  type ProjectKeyId,
  summarizeBatch,
  type Timestamp,
  toTimestamp,
} from "@moriyoshi/errtraq-core";
import { createApiApp } from "@moriyoshi/errtraq-http";
import { describe, expect, it, vi } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import {
  MemoryArchiveStore,
  MemoryBlobStore,
  MemoryKV,
} from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

type Requester = {
  app: {
    request(path: string, init?: RequestInit): Response | Promise<Response>;
  };
};
const auth = { authorization: "Bearer errtraq_secret" };

async function setup(
  options: {
    archive?: boolean;
    ingestUrl?: string;
    cors?: { origins: string[]; maxAgeSec?: number };
    events?: number;
  } = {},
) {
  const store = new MemoryActiveStore();
  const archive = new MemoryArchiveStore();
  const clock = new FakeClock();
  const boot = await bootstrapProject({
    store,
    kv: new MemoryKV(clock),
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "project",
  });
  await store.projects.putToken({
    id: "token" as ApiTokenId,
    orgId: boot.org.id,
    tokenHash: await hashApiToken("errtraq_secret"),
    scopes: ["event:read", "event:write"],
  });
  const projectId = boot.project.id;
  const rows = [];
  for (let n = 1; n <= (options.events ?? 3); n++) {
    const receivedAt = toTimestamp(
      new Date(Date.parse(clock.now()) + n * 1000),
    );
    const row = {
      projectId,
      issueId: "issue-1" as IssueId,
      eventId: `event-${n}` as EventId,
      receivedAt,
      timestamp: receivedAt,
      level: "error" as const,
      tags: {},
      payload: { message: `event ${n}` },
    };
    rows.push(row);
    await store.recordEvent(
      {
        projectId,
        issueId: row.issueId,
        eventId: row.eventId,
        receivedAt,
        timestamp: receivedAt,
        fingerprint: "fp",
        title: "error",
        culprit: "test",
        type: "Error",
        metadata: {},
        level: "error",
      },
      row,
    );
  }
  const app = createApiApp({
    store,
    clock,
    blobs: new MemoryBlobStore(),
    ...(options.archive ? { archive } : {}),
    ...(options.ingestUrl ? { ingestUrl: options.ingestUrl } : {}),
    ...(options.cors ? { cors: options.cors } : {}),
  });
  return { store, archive, app, boot, rows, projectId, clock };
}
const get = (c: Requester, path: string) =>
  Promise.resolve(c.app.request(path, { headers: auth }));

describe("organization and project routes", () => {
  it("serves the token organization and 404s on another one", async () => {
    const c = await setup();
    await c.store.projects.putOrg({
      id: "other-org" as OrgId,
      slug: "other",
      name: "Other",
    });
    const list = await (await get(c, "/api/0/organizations/")).json();
    expect(list).toEqual([
      { id: c.boot.org.id, slug: "org", name: c.boot.org.name },
    ]);
    expect((await get(c, "/api/0/organizations/org/")).status).toBe(200);
    for (const path of [
      "/api/0/organizations/other/",
      "/api/0/organizations/other/projects/",
      "/api/0/organizations/missing/projects/",
    ])
      expect((await get(c, path)).status).toBe(404);
    const projects = await (
      await get(c, "/api/0/organizations/org/projects/")
    ).json();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: c.projectId,
      slug: "project",
      organization: { slug: "org" },
      errtraq: { retentionDays: c.boot.project.retentionDays },
    });
    const one = await (await get(c, "/api/0/projects/org/project/")).json();
    expect(one).toEqual(projects[0]);
    expect((await get(c, "/api/0/projects/other/project/")).status).toBe(404);
    expect((await get(c, "/api/0/projects/org/nope/")).status).toBe(404);
  });

  it("passes an empty page with a cursor through instead of looping", async () => {
    const c = await setup();
    const spy = vi.spyOn(c.store.projects, "listByOrg").mockImplementation(
      async (): Promise<Page<Project>> => ({
        items: [],
        nextCursor: "next-page" as never,
      }),
    );
    const response = await get(c, "/api/0/organizations/org/projects/?limit=5");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(response.headers.get("link")).toContain(
      'rel="next"; results="true"; cursor="next-page"',
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[2]).toBe(5);
    expect(
      (await get(c, "/api/0/organizations/org/projects/?bogus=1")).status,
    ).toBe(400);
  });
});

describe("capabilities on the root route", () => {
  it("keeps auth and user and adds errtraq capabilities", async () => {
    for (const archive of [false, true]) {
      const c = await setup({ archive });
      const json = await (await get(c, "/api/0/")).json();
      expect(json.auth).toEqual({ scopes: ["event:read", "event:write"] });
      expect(json.user).toBeNull();
      expect(json.errtraq.capabilities).toEqual({
        textSearch: c.store.capabilities.textSearch,
        lastSeenRangeOnOtherSort: c.store.capabilities.lastSeenRangeOnOtherSort,
        archive,
        issueStats: true,
        tagFacets: true,
      });
    }
  });
});

describe("event navigation", () => {
  it("serves oldest and previous / next ids, null at both ends", async () => {
    const c = await setup();
    const oldest = await (
      await get(c, "/api/0/issues/issue-1/events/oldest/")
    ).json();
    expect(oldest.eventID).toBe("event-1");
    expect(oldest.previousEventID).toBeNull();
    expect(oldest.nextEventID).toBe("event-2");
    const middle = await (
      await get(c, "/api/0/issues/issue-1/events/event-2/")
    ).json();
    expect([middle.previousEventID, middle.nextEventID]).toEqual([
      "event-1",
      "event-3",
    ]);
    const latest = await (
      await get(c, "/api/0/issues/issue-1/events/latest/")
    ).json();
    expect([latest.previousEventID, latest.nextEventID]).toEqual([
      "event-2",
      null,
    ]);
    const byProject = await (
      await get(c, "/api/0/projects/org/project/events/event-3/")
    ).json();
    expect([byProject.previousEventID, byProject.nextEventID]).toEqual([
      "event-2",
      null,
    ]);
    const list = await (await get(c, "/api/0/issues/issue-1/events/")).json();
    expect(list[0]).not.toHaveProperty("previousEventID");
    expect((await get(c, "/api/0/issues/nope/events/oldest/")).status).toBe(
      404,
    );
  });

  it("follows empty source pages that carry a cursor", async () => {
    const c = await setup();
    const real = c.store.events.listByIssue.bind(c.store.events);
    const original = new Map<string, Parameters<typeof real>[0]>();
    let injected = 0;
    vi.spyOn(c.store.events, "listByIssue").mockImplementation(async (q) => {
      const held = q.cursor ? original.get(q.cursor) : undefined;
      if (held) return real(held);
      if (!q.cursor && injected < 2) {
        // An empty page whose cursor resumes the same query.
        const token = `skip-${injected++}`;
        original.set(token, q);
        return { items: [], hasMore: true, nextCursor: token as never };
      }
      return real(q);
    });
    const body = await (
      await get(c, "/api/0/issues/issue-1/events/event-2/")
    ).json();
    expect(injected).toBe(2);
    expect([body.previousEventID, body.nextEventID]).toEqual([
      "event-1",
      "event-3",
    ]);
  });

  it("crosses the archive watermark in both directions", async () => {
    const c = await setup({ archive: true, events: 4 });
    const old = c.rows.slice(0, 2);
    await c.archive.append({
      batchId: "b",
      dayRange: summarizeBatch(old).dayRange,
      rows: old,
    });
    await c.store.events.deleteBatch(
      c.projectId,
      old.map((r) => r.eventId),
    );
    await c.store.meta.compareAndSetArchiveState(c.projectId, null, {
      projectId: c.projectId,
      version: 0,
      archivedThrough: c.rows[1]?.receivedAt as Timestamp,
      seq: 1,
    });
    const third = await (
      await get(c, "/api/0/issues/issue-1/events/event-3/")
    ).json();
    expect([third.previousEventID, third.nextEventID]).toEqual([
      "event-2",
      "event-4",
    ]);
    const oldest = await (
      await get(c, "/api/0/issues/issue-1/events/oldest/")
    ).json();
    expect(oldest.eventID).toBe("event-1");
    expect(oldest.nextEventID).toBe("event-2");
    const second = await (
      await get(c, "/api/0/issues/issue-1/events/event-2/")
    ).json();
    expect([second.previousEventID, second.nextEventID]).toEqual([
      "event-1",
      "event-3",
    ]);
  });
});

describe("bulk status update", () => {
  async function twoIssues() {
    const c = await setup();
    const row = c.rows[0];
    if (!row) throw new Error("rows");
    await c.store.recordEvent(
      {
        projectId: c.projectId,
        issueId: "issue-2" as IssueId,
        eventId: "event-x" as EventId,
        receivedAt: row.receivedAt,
        timestamp: row.timestamp,
        fingerprint: "fp2",
        title: "second",
        culprit: "test",
        type: "Error",
        metadata: {},
        level: "error",
      },
      { ...row, issueId: "issue-2" as IssueId, eventId: "event-x" as EventId },
    );
    return c;
  }
  const put = async (c: Requester, query: string, body: unknown) =>
    c.app.request(`/api/0/projects/org/project/issues/${query}`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const statusOf = async (c: Awaited<ReturnType<typeof setup>>, id: string) =>
    (await c.store.issues.get(c.projectId, id as IssueId))?.status;

  it("updates every listed issue", async () => {
    const c = await twoIssues();
    const response = await put(c, "?id=issue-1&id=issue-2", {
      status: "resolved",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "resolved",
      statusDetails: {},
    });
    expect(await statusOf(c, "issue-1")).toBe("resolved");
    expect(await statusOf(c, "issue-2")).toBe("resolved");
  });

  it("writes nothing when any id is unknown", async () => {
    const c = await twoIssues();
    const response = await put(c, "?id=issue-1&id=missing", {
      status: "ignored",
    });
    expect(response.status).toBe(404);
    expect(await statusOf(c, "issue-1")).toBe("unresolved");
  });

  it("validates the id count, query parameters and body", async () => {
    const c = await twoIssues();
    const many = (n: number) =>
      `?${Array.from({ length: n }, () => "id=issue-1").join("&")}`;
    expect((await put(c, "", { status: "resolved" })).status).toBe(400);
    expect((await put(c, many(101), { status: "resolved" })).status).toBe(400);
    expect((await put(c, many(100), { status: "resolved" })).status).toBe(200);
    expect(
      (await put(c, "?id=issue-1&status=x", { status: "resolved" })).status,
    ).toBe(400);
    expect((await put(c, "?id=issue-1", { status: "bogus" })).status).toBe(400);
  });

  it("does not reach another organization's project", async () => {
    const c = await twoIssues();
    const response = await c.app.request(
      "/api/0/projects/other/project/issues/?id=issue-1",
      {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      },
    );
    expect(response.status).toBe(404);
  });
});

describe("DSN keys", () => {
  it("omits dsn without ingestUrl and never emits the secret", async () => {
    const c = await setup();
    const keys = await (
      await get(c, "/api/0/projects/org/project/keys/")
    ).json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: "Default", isActive: true });
    expect(keys[0]).not.toHaveProperty("dsn");
    expect(keys[0]).not.toHaveProperty("secret");
    expect(typeof keys[0].public).toBe("string");
    expect((await get(c, "/api/0/projects/other/project/keys/")).status).toBe(
      404,
    );
  });

  it("builds the public DSN from ingestUrl and flags revoked keys", async () => {
    const c = await setup({ ingestUrl: "https://ingest.example.com" });
    const [key] = await c.store.projects.listKeys(c.projectId);
    if (!key) throw new Error("key");
    await c.store.projects.putKey({
      id: "revoked" as ProjectKeyId,
      projectId: c.projectId,
      publicKey: "deadbeef",
      revokedAt: c.clock.now(),
    });
    const keys = await (
      await get(c, "/api/0/projects/org/project/keys/")
    ).json();
    const active = keys.find(
      (k: { public: string }) => k.public === key.publicKey,
    );
    expect(active.dsn.public).toBe(
      `https://${key.publicKey}@ingest.example.com/${c.projectId}`,
    );
    const revoked = keys.find((k: { id: string }) => k.id === "revoked");
    expect(revoked.isActive).toBe(false);
  });

  it("keeps an ingest path prefix in front of the project ID", async () => {
    const c = await setup({ ingestUrl: "https://example.com/errtraq/" });
    const [key] = await c.store.projects.listKeys(c.projectId);
    if (!key) throw new Error("key");
    const [listed] = await (
      await get(c, "/api/0/projects/org/project/keys/")
    ).json();
    expect(listed.dsn.public).toBe(
      `https://${key.publicKey}@example.com/errtraq/${c.projectId}`,
    );
  });
});

describe("CORS", () => {
  const origin = "https://ui.example.com";
  it("is off by default", async () => {
    const c = await setup();
    const response = await c.app.request("/api/0/", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "GET" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers a preflight without a token and exposes Link", async () => {
    const c = await setup({ cors: { origins: [origin] } });
    const response = await c.app.request(
      "/api/0/projects/org/project/issues/",
      {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "PUT",
          "access-control-request-headers": "authorization,content-type",
        },
      },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-max-age")).toBe("86400");
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "PUT",
    );
    const allowed = response.headers.get("access-control-allow-headers") ?? "";
    expect(allowed.toLowerCase()).toContain("authorization");
    const real = await c.app.request("/api/0/issues/issue-1/events/", {
      headers: { ...auth, origin },
    });
    expect(real.headers.get("access-control-allow-origin")).toBe(origin);
    expect(real.headers.get("access-control-expose-headers")).toContain("Link");
    const unauthenticated = await c.app.request("/api/0/", {
      headers: { origin },
    });
    expect(unauthenticated.status).toBe(401);
  });

  it("does not allow other origins", async () => {
    const c = await setup({ cors: { origins: [origin], maxAgeSec: 60 } });
    const response = await c.app.request("/api/0/", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects wildcards and malformed origins at construction", async () => {
    for (const bad of [
      "*",
      "https://ui.example.com/path",
      "ui.example.com",
      "",
    ])
      await expect(setup({ cors: { origins: [bad] } })).rejects.toThrow();
    await expect(setup({ cors: { origins: [] } })).rejects.toThrow();
  });
});
