import {
  type ApiTokenId,
  bootstrapProject,
  ConsumerService,
  type EventId,
  hashApiToken,
  type IssueId,
  type ProjectId,
  type RateRejectionConfig,
  RateRejector,
  readDropped,
  toTimestamp,
  VersionConflictError,
  WebCryptoIdGen,
} from "@errtraq/core";
import { createApiApp } from "@errtraq/http";
import { describe, expect, it, vi } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryBlobStore, MemoryKV } from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

async function setup(rateRejection?: RateRejectionConfig) {
  const store = new MemoryActiveStore();
  const clock = new FakeClock();
  const kv = new MemoryKV(clock);
  const boot = await bootstrapProject({
    store,
    kv,
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "project",
  });
  await store.projects.putToken({
    id: "token" as ApiTokenId,
    orgId: boot.org.id,
    tokenHash: await hashApiToken("secret"),
    scopes: ["event:read", "event:write"],
  });
  await store.projects.putToken({
    id: "readonly" as ApiTokenId,
    orgId: boot.org.id,
    tokenHash: await hashApiToken("read"),
    scopes: ["event:read"],
  });
  const blobs = new MemoryBlobStore();
  const logger = { error: vi.fn() };
  const app = createApiApp({ store, clock, blobs, logger, kv, rateRejection });
  const auth = { authorization: "Bearer secret" };
  async function seed(n: number) {
    const eventId = `event-${n}` as EventId;
    const issueId = `issue-${n}` as IssueId;
    const timestamp = toTimestamp(new Date(Date.parse(clock.now()) + n * 1000));
    await store.recordEvent(
      {
        projectId: boot.project.id,
        issueId,
        eventId,
        receivedAt: timestamp,
        timestamp,
        fingerprint: `fp-${n}`,
        title: `error ${n}`,
        culprit: "test",
        type: "Error",
        metadata: {},
        level: "error",
      },
      {
        projectId: boot.project.id,
        issueId,
        eventId,
        receivedAt: timestamp,
        timestamp,
        level: "error",
        tags: {},
        payload: { message: `event ${n}` },
      },
    );
  }
  return { store, clock, boot, app, auth, seed, blobs, logger, kv };
}
describe("approximate dropped counts", () => {
  for (const config of [
    { issueRateLimit: { events: 1, windowSec: 60 } },
    { newIssueCap: { issues: 1, windowSec: 60 } },
  ]) {
    it("shows the current received-at window in list and detail and advances at expiry", async () => {
      const c = await setup(config);
      await c.seed(1);
      const rejector = new RateRejector({
        kv: c.kv,
        config,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
      const candidate = {
        projectId: c.boot.project.id,
        issueId: "issue-1",
        receivedAt: c.clock.now(),
      };
      await rejector.recordDropped([candidate, candidate]);
      const paths = [
        "/api/0/issues/issue-1",
        "/api/0/projects/org/project/issues/",
      ];
      for (const path of paths) {
        const response = await c.app.request(path, { headers: c.auth });
        expect(response.status).toBe(200);
        const json = await response.json();
        const issue = Array.isArray(json) ? json[0] : json;
        expect(issue.approximateDropped).toEqual({
          count: 2,
          windowSec: 60,
          windowStart: "2024-01-01T00:00:00.000Z",
          windowEnd: "2024-01-01T00:01:00.000Z",
          timeBasis: "receivedAt",
        });
      }
      c.clock.advance(60000);
      // A delayed old event increments its original received-at bucket, not this one.
      await rejector.recordDropped([candidate]);
      const response = await c.app.request("/api/0/issues/issue-1", {
        headers: c.auth,
      });
      const issue = await response.json();
      expect(issue.approximateDropped).toEqual({
        count: 0,
        windowSec: 60,
        windowStart: "2024-01-01T00:01:00.000Z",
        windowEnd: "2024-01-01T00:02:00.000Z",
        timeBasis: "receivedAt",
      });
      c.clock.advance(120000);
      expect(
        await readDropped(
          c.kv,
          config,
          c.boot.project.id,
          candidate.issueId,
          candidate.receivedAt,
        ),
      ).toEqual({ count: 0, windowSec: 60 });
    });
  }
  it("reports drops from the real consumer for the right issue and window only", async () => {
    const config = { issueRateLimit: { events: 1, windowSec: 60 } };
    const c = await setup(config);
    const consumer = new ConsumerService({
      store: c.store,
      blobs: c.blobs,
      kv: c.kv,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      rateRejection: config,
    });
    let seq = 0;
    const deliver = async (messages: string[]) => {
      const blobKey = `envelopes/${++seq}`;
      const text = `{}\n${messages.map((message, i) => `{"type":"event"}\n${JSON.stringify({ event_id: (seq * 100 + i).toString(16).padStart(32, "0"), message })}\n`).join("")}`;
      const bytes = new TextEncoder().encode(text);
      await c.blobs.put(blobKey, bytes, { size: bytes.length });
      const results = await consumer.handle([
        {
          id: `d${seq}`,
          topic: "ingest",
          attempt: 1,
          message: {
            key: (seq * 100).toString(16).padStart(32, "0"),
            body: {
              projectId: c.boot.project.id,
              blobKey,
              receivedAt: c.clock.now(),
            },
          },
        },
      ]);
      expect(results.map((r) => r.action)).toEqual(["ack"]);
    };
    const drops = async () => {
      const response = await c.app.request(
        "/api/0/projects/org/project/issues/",
        { headers: c.auth },
      );
      const issues = (await response.json()) as {
        title: string;
        approximateDropped: { count: number; windowStart: string };
      }[];
      return Object.fromEntries(
        issues.map((i) => [i.title, i.approximateDropped.count]),
      );
    };
    await deliver(["alpha", "alpha", "alpha", "beta", "beta"]);
    expect(await drops()).toEqual({ alpha: 2, beta: 1 });
    c.clock.advance(60_000);
    expect(await drops()).toEqual({ alpha: 0, beta: 0 });
    await deliver(["alpha", "alpha"]);
    expect(await drops()).toEqual({ alpha: 1, beta: 0 });
  });
  it("omits the field when disabled or if the KV read fails, without exposing the error", async () => {
    const disabled = await setup();
    await disabled.seed(1);
    for (const path of [
      "/api/0/issues/issue-1",
      "/api/0/projects/org/project/issues/",
    ]) {
      const response = await disabled.app.request(path, {
        headers: disabled.auth,
      });
      const json = await response.json();
      expect(Array.isArray(json) ? json[0] : json).not.toHaveProperty(
        "approximateDropped",
      );
    }
    const c = await setup({ issueRateLimit: { events: 1, windowSec: 60 } });
    await c.seed(1);
    vi.spyOn(c.kv, "get").mockRejectedValue(
      new Error("private provider details"),
    );
    for (const path of [
      "/api/0/issues/issue-1",
      "/api/0/projects/org/project/issues/",
    ]) {
      const response = await c.app.request(path, { headers: c.auth });
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(Array.isArray(json) ? json[0] : json).not.toHaveProperty(
        "approximateDropped",
      );
      expect(JSON.stringify(json)).not.toContain("private provider details");
    }
  });
});
describe("minimal API", () => {
  it("reports subject erasure as unavailable without mutating events", async () => {
    const c = await setup();
    await c.seed(1);
    for (const method of ["GET", "POST"]) {
      const response = await c.app.request(
        "/api/0/projects/org/project/erasure-requests/",
        { method, headers: c.auth },
      );
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({
        detail: "Subject erasure is unavailable until M4",
      });
    }
    expect(
      (await c.store.issues.get(c.boot.project.id, "issue-1" as IssueId))
        ?.count,
    ).toBe(1);
  });

  it("retains a continuation on an empty examined event page", async () => {
    const c = await setup();
    await c.seed(1);
    vi.spyOn(c.store.events, "listByIssue").mockResolvedValueOnce({
      items: [],
      hasMore: true,
      nextCursor: "opaque" as import("@errtraq/core").Cursor,
    });
    const response = await c.app.request("/api/0/issues/issue-1/events/", {
      headers: c.auth,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(response.headers.get("link")).toContain('cursor="opaque"');
  });
  it("checks hashed bearer tokens, scopes and organization ownership", async () => {
    const c = await setup();
    await c.seed(1);
    expect((await c.app.request("/api/0/issues/issue-1/")).status).toBe(401);
    expect(
      (
        await c.app.request("/api/0/issues/issue-1/", {
          headers: { authorization: "Bearer invalid" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await c.app.request("/api/0/issues/issue-1/", {
          method: "PUT",
          headers: {
            authorization: "Bearer read",
            "content-type": "application/json",
          },
          body: JSON.stringify({ status: "resolved" }),
        })
      ).status,
    ).toBe(403);
    const other = await bootstrapProject({
      store: c.store,
      kv: new MemoryKV(c.clock),
      ids: new WebCryptoIdGen(),
      orgSlug: "other",
      projectSlug: "other",
    });
    expect(
      (
        await c.app.request(`/api/0/projects/other/other/issues/`, {
          headers: c.auth,
        })
      ).status,
    ).toBe(404);
    expect(other.project.id).not.toBe(c.boot.project.id);
  });
  it("lists issues with filters, keyset links and clear unsupported-query errors", async () => {
    const c = await setup();
    await c.seed(1);
    await c.seed(2);
    const first = await c.app.request(
      "/api/0/projects/org/project/issues/?limit=1&sort=lastSeen",
      { headers: c.auth },
    );
    expect(first.status).toBe(200);
    const rows = (await first.json()) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    const link = first.headers.get("link");
    const next = link?.match(/cursor="([^"]+)"/)?.[1];
    expect(next).toBeTruthy();
    const second = await c.app.request(
      `/api/0/projects/org/project/issues/?limit=1&sort=lastSeen&cursor=${next}`,
      { headers: c.auth },
    );
    expect(second.status).toBe(200);
    const rows2 = (await second.json()) as Array<{ id: string }>;
    expect(rows2[0]?.id).not.toBe(rows[0]?.id);
    expect(
      (
        await c.app.request("/api/0/projects/org/project/issues/?query=text", {
          headers: c.auth,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.app.request(
          "/api/0/projects/org/project/issues/?cursor=invalid",
          { headers: c.auth },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await c.app.request("/api/0/projects/org/project/issues/?status=bad", {
          headers: c.auth,
        })
      ).status,
    ).toBe(400);
  });
  it("gets, resolves, ignores and unresolves an issue and retrieves its events", async () => {
    const c = await setup();
    await c.seed(1);
    const path = "/api/0/issues/issue-1/";
    expect((await c.app.request(path, { headers: c.auth })).status).toBe(200);
    for (const status of ["resolved", "ignored", "unresolved"]) {
      const response = await c.app.request(path, {
        method: "PUT",
        headers: { ...c.auth, "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status });
    }
    const events = await c.app.request(`${path}events/`, { headers: c.auth });
    expect(await events.json()).toMatchObject([{ eventID: "event-1" }]);
    const latest = await c.app.request(`${path}events/latest/`, {
      headers: c.auth,
    });
    expect(await latest.json()).toMatchObject({ eventID: "event-1" });
    const event = await c.app.request(
      "/api/0/projects/org/project/events/event-1/",
      { headers: c.auth },
    );
    expect(await event.json()).toMatchObject({ eventID: "event-1" });
    expect(
      (await c.app.request("/api/0/issues/missing/", { headers: c.auth }))
        .status,
    ).toBe(404);
    expect(
      (
        await c.app.request("/api/0/projects/org/project/events/missing/", {
          headers: c.auth,
        })
      ).status,
    ).toBe(404);
    expect(
      await c.store.issues.get("999" as ProjectId, "issue-1" as IssueId),
    ).toBeNull();
  });
  it("loads overflow event payloads and refuses cross-issue lookups", async () => {
    const c = await setup();
    const eventId = "large" as EventId,
      issueId = "overflow" as IssueId,
      timestamp = c.clock.now();
    await c.blobs.put(
      "payload",
      new TextEncoder().encode(JSON.stringify({ message: "large body" })),
    );
    await c.store.recordEvent(
      {
        projectId: c.boot.project.id,
        issueId,
        eventId,
        receivedAt: timestamp,
        timestamp,
        fingerprint: "overflow",
        title: "large",
        culprit: "",
        level: "error",
        type: "default",
        metadata: {},
      },
      {
        projectId: c.boot.project.id,
        issueId,
        eventId,
        receivedAt: timestamp,
        timestamp,
        level: "error",
        tags: {},
        payload: {},
        payloadBlobKey: "payload",
      },
    );
    const response = await c.app.request(
      "/api/0/issues/overflow/events/latest/",
      { headers: c.auth },
    );
    expect(await response.json()).toMatchObject({
      eventID: "large",
      message: "large body",
    });
    await c.seed(1);
    expect(
      (
        await c.app.request("/api/0/issues/issue-1/events/large/", {
          headers: c.auth,
        })
      ).status,
    ).toBe(404);
  });
  it("logs internal syntax and range failures with a request ID and retries version conflicts", async () => {
    const c = await setup();
    await c.seed(1);
    vi.spyOn(c.store.issues, "getById").mockRejectedValueOnce(
      new SyntaxError("corrupt storage"),
    );
    const failure = await c.app.request("/api/0/issues/issue-1/", {
      headers: c.auth,
    });
    expect(failure.status).toBe(500);
    const body = (await failure.json()) as {
      detail: string;
      requestId: string;
    };
    expect(body.detail).toBe("Internal server error");
    expect(body.requestId).toBeTruthy();
    expect(c.logger.error).toHaveBeenCalledWith(
      "HTTP request failed",
      expect.objectContaining({
        requestId: body.requestId,
        message: "corrupt storage",
        stack: expect.any(String),
      }),
    );
    vi.spyOn(c.store.issues, "getById").mockRejectedValueOnce(
      new RangeError("internal range"),
    );
    expect(
      (await c.app.request("/api/0/issues/issue-1/", { headers: c.auth }))
        .status,
    ).toBe(500);
    const update = vi
      .spyOn(c.store.issues, "update")
      .mockRejectedValue(new VersionConflictError());
    const result = await c.app.request("/api/0/issues/issue-1/", {
      method: "PUT",
      headers: { ...c.auth, "content-type": "application/json" },
      body: '{"status":"resolved"}',
    });
    expect(result.status).toBe(409);
    expect(update).toHaveBeenCalledTimes(3);
  });
  it("accepts Sentry list query options and organization route", async () => {
    const c = await setup();
    await c.seed(1);
    const path = `/api/0/organizations/org/issues?project=${c.boot.project.id}&query=is:unresolved&per_page=1&statsPeriod=24h&cursor=`;
    expect((await c.app.request(path, { headers: c.auth })).status).toBe(200);
    expect(
      (
        await c.app.request("/api/0/organizations/org/issues", {
          headers: c.auth,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.app.request(
          `/api/0/organizations/org/issues?project=${c.boot.project.id}&project=${c.boot.project.id}`,
          { headers: c.auth },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await c.app.request("/api/0/projects/org/project/issues?query=hello", {
          headers: c.auth,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.app.request(
          "/api/0/projects/org/project/issues?environment=prod",
          { headers: c.auth },
        )
      ).status,
    ).toBe(400);
  });
});
