import {
  type ApiTokenId,
  bootstrapProject,
  type EventId,
  hashApiToken,
  type IssueId,
  type ProjectId,
  type StoredEvent,
  type Timestamp,
} from "@moriyoshi/errtraq-core";
import { createApiApp } from "@moriyoshi/errtraq-http";
import { describe, expect, it, vi } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryBlobStore, MemoryKV } from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

const auth = { authorization: "Bearer secret" };
const now = "2024-03-10T12:30:00.000Z";
const ts = (iso: string) => iso as Timestamp;

async function setup(statsOn = true) {
  const store = new MemoryActiveStore(undefined, "explicit", {
    stats: statsOn,
  });
  const clock = new FakeClock(now);
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
    tokenHash: await hashApiToken("secret"),
    scopes: ["event:read", "event:write"],
  });
  const projectId = boot.project.id as ProjectId;
  let n = 0;
  const record = async (
    issue: string,
    receivedAt: string,
    extra: Partial<StoredEvent> = {},
  ) => {
    const eventId = `e${++n}` as EventId;
    const at = ts(receivedAt);
    const event: StoredEvent = {
      projectId,
      issueId: issue as IssueId,
      eventId,
      receivedAt: at,
      timestamp: at,
      level: "error",
      tags: {},
      payload: { message: eventId },
      ...extra,
    };
    await store.recordEvent(
      {
        projectId,
        issueId: issue as IssueId,
        eventId,
        receivedAt: at,
        timestamp: at,
        fingerprint: issue,
        title: issue,
        culprit: "c",
        type: "Error",
        metadata: {},
        level: "error",
      },
      event,
    );
  };
  const app = createApiApp({ store, clock, blobs: new MemoryBlobStore() });
  const get = (path: string) =>
    Promise.resolve(app.request(path, { headers: auth }));
  return { store, app, get, record, boot, projectId };
}
const list = "/api/0/projects/org/project/issues/";

describe("issue list statsPeriod", () => {
  it("adds nothing without statsPeriod and rejects other values", async () => {
    const c = await setup();
    await c.record("i1", "2024-03-10T12:10:00.000Z");
    for (const path of [list, `${list}?statsPeriod=`]) {
      const rows = await (await c.get(path)).json();
      expect(rows[0]).not.toHaveProperty("stats");
    }
    for (const bad of ["7d", "1h", "90d", "24H"])
      expect((await c.get(`${list}?statsPeriod=${bad}`)).status).toBe(400);
  });

  it("serves zero-filled 24h hourly points from one batched call", async () => {
    const c = await setup();
    await c.record("i1", "2024-03-10T12:10:00.000Z");
    await c.record("i1", "2024-03-10T12:40:00.000Z");
    await c.record("i1", "2024-03-10T01:00:00.000Z");
    await c.record("i2", "2024-03-09T13:59:59.999Z");
    await c.record("i2", "2024-03-09T12:59:59.999Z"); // before the window
    const spy = vi.spyOn(c.store.stats, "series");
    const rows = await (await c.get(`${list}?statsPeriod=24h`)).json();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toHaveLength(2);
    const byId = Object.fromEntries(rows.map((r: { id: string }) => [r.id, r]));
    const i1 = byId.i1.stats["24h"] as Array<[number, number]>;
    expect(i1).toHaveLength(24);
    expect(i1.at(-1)).toEqual([Date.parse("2024-03-10T12:00:00Z") / 1000, 2]);
    expect(i1.reduce((n, [, v]) => n + v, 0)).toBe(3);
    expect(Object.keys(byId.i1.stats)).toEqual(["24h"]);
    const i2 = byId.i2.stats["24h"] as Array<[number, number]>;
    expect(i2[0]).toEqual([Date.parse("2024-03-09T13:00:00Z") / 1000, 1]);
    expect(i2.reduce((n, [, v]) => n + v, 0)).toBe(1);
  });

  it("sums hourly buckets into 14 daily points", async () => {
    const c = await setup();
    await c.record("i1", "2024-03-10T00:00:00.000Z");
    await c.record("i1", "2024-03-10T23:00:00.000Z");
    await c.record("i1", "2024-02-26T05:00:00.000Z");
    await c.record("i1", "2024-02-25T05:00:00.000Z");
    const [row] = await (await c.get(`${list}?statsPeriod=14d`)).json();
    const points = row.stats["14d"] as Array<[number, number]>;
    expect(points).toHaveLength(14);
    expect(points[0]).toEqual([Date.parse("2024-02-26T00:00:00Z") / 1000, 1]);
    expect(points.at(-1)).toEqual([
      Date.parse("2024-03-10T00:00:00Z") / 1000,
      2,
    ]);
    expect(points.reduce((n, [, v]) => n + v, 0)).toBe(3);
  });

  it("is a 400 on a store without the capability", async () => {
    const c = await setup(false);
    await c.record("i1", "2024-03-10T12:10:00.000Z");
    const response = await c.get(`${list}?statsPeriod=24h`);
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toMatch(
      /not supported by this store/,
    );
    expect((await c.get(list)).status).toBe(200);
  });
});

describe("issue detail stats", () => {
  it("returns 24h and 30d series with the time basis", async () => {
    const c = await setup();
    await c.record("i1", "2024-03-10T12:10:00.000Z");
    await c.record("i1", "2024-02-20T12:10:00.000Z");
    const issue = await (await c.get("/api/0/issues/i1/")).json();
    expect(issue.timeBasis).toBe("receivedAt");
    expect(issue.stats["24h"]).toHaveLength(24);
    expect(issue.stats["30d"]).toHaveLength(30);
    expect(
      issue.stats["24h"].reduce(
        (n: number, [, v]: number[]) => n + (v ?? 0),
        0,
      ),
    ).toBe(1);
    expect(
      issue.stats["30d"].reduce(
        (n: number, [, v]: number[]) => n + (v ?? 0),
        0,
      ),
    ).toBe(2);
  });
  it("omits stats on a store without the capability", async () => {
    const c = await setup(false);
    await c.record("i1", "2024-03-10T12:10:00.000Z");
    const issue = await (await c.get("/api/0/issues/i1/")).json();
    expect(issue).not.toHaveProperty("stats");
    expect(issue).not.toHaveProperty("timeBasis");
  });
});

describe("tag routes", () => {
  it("lists facets in Sentry's shape", async () => {
    const c = await setup();
    await c.record("i1", "2024-03-10T12:10:00.000Z", {
      environment: "prod",
      tags: { "browser.name": "Firefox", "user.email": "a@example.com" },
    });
    await c.record("i1", "2024-03-10T12:11:00.000Z", { environment: "prod" });
    await c.record("i1", "2024-03-10T12:12:00.000Z", { environment: "dev" });
    const tags = await (await c.get("/api/0/issues/i1/tags/")).json();
    expect(tags.map((t: { key: string }) => t.key)).toEqual([
      "level",
      "environment",
      "browser.name",
    ]);
    expect(tags[1]).toEqual({
      key: "environment",
      name: "Environment",
      totalValues: 3,
      uniqueValues: 2,
      topValues: [
        { key: "environment", name: "prod", value: "prod", count: 2 },
        { key: "environment", name: "dev", value: "dev", count: 1 },
      ],
    });
    expect(JSON.stringify(tags)).not.toContain("example.com");
    const one = await (
      await c.get("/api/0/issues/i1/tags/environment/")
    ).json();
    expect(one).toEqual(tags[1]);
    const empty = await (await c.get("/api/0/issues/i1/tags/os.name/")).json();
    expect(empty).toMatchObject({
      key: "os.name",
      totalValues: 0,
      topValues: [],
    });
  });

  it("pages values with the Link header", async () => {
    const c = await setup();
    for (let i = 0; i < 5; i++)
      for (let k = 0; k <= i; k++)
        await c.record("i1", "2024-03-10T12:10:00.000Z", {
          tags: { server_name: `host-${i}` },
        });
    const first = await c.get(
      "/api/0/issues/i1/tags/server_name/values/?limit=2",
    );
    expect(await first.json()).toEqual([
      { key: "server_name", name: "host-4", value: "host-4", count: 5 },
      { key: "server_name", name: "host-3", value: "host-3", count: 4 },
    ]);
    const next = /rel="next"; results="true"; cursor="([^"]+)"/.exec(
      first.headers.get("link") ?? "",
    )?.[1];
    expect(next).toBeTruthy();
    const second = await (
      await c.get(
        `/api/0/issues/i1/tags/server_name/values/?limit=2&cursor=${encodeURIComponent(next ?? "")}`,
      )
    ).json();
    expect(second.map((v: { value: string }) => v.value)).toEqual([
      "host-2",
      "host-1",
    ]);
    const bad = await c.get(
      "/api/0/issues/i1/tags/server_name/values/?cursor=junk",
    );
    expect(bad.status).toBe(400);
  });

  it("404s on non-allow-listed keys and issues of other organizations", async () => {
    const c = await setup();
    await c.record("i1", "2024-03-10T12:10:00.000Z", {
      tags: { "user.email": "a@example.com" },
    });
    for (const key of ["user.email", "url", "user", "nope"]) {
      expect((await c.get(`/api/0/issues/i1/tags/${key}/`)).status).toBe(404);
      expect((await c.get(`/api/0/issues/i1/tags/${key}/values/`)).status).toBe(
        404,
      );
    }
    expect((await c.get("/api/0/issues/missing/tags/")).status).toBe(404);
    expect(
      (await c.get("/api/0/issues/missing/tags/level/values/")).status,
    ).toBe(404);
    const anon = await Promise.resolve(c.app.request("/api/0/issues/i1/tags/"));
    expect(anon.status).toBe(401);
    await c.store.projects.putOrg({
      id: "o2" as never,
      slug: "o2",
      name: "O2",
    });
    await c.store.projects.put({
      id: "9" as ProjectId,
      orgId: "o2" as never,
      slug: "p2",
      name: "P2",
      retentionDays: 30,
    });
    await c.store.recordEvent(
      {
        projectId: "9" as ProjectId,
        issueId: "foreign" as IssueId,
        eventId: "fe" as EventId,
        receivedAt: ts("2024-03-10T12:00:00.000Z"),
        timestamp: ts("2024-03-10T12:00:00.000Z"),
        fingerprint: "foreign",
        title: "t",
        culprit: "c",
        type: "Error",
        metadata: {},
        level: "error",
      },
      {
        projectId: "9" as ProjectId,
        issueId: "foreign" as IssueId,
        eventId: "fe" as EventId,
        receivedAt: ts("2024-03-10T12:00:00.000Z"),
        timestamp: ts("2024-03-10T12:00:00.000Z"),
        level: "error",
        tags: {},
        payload: {},
      },
    );
    expect((await c.get("/api/0/issues/foreign/tags/")).status).toBe(404);
    expect(
      (await c.get("/api/0/issues/foreign/tags/level/values/")).status,
    ).toBe(404);
  });

  it("is a 400 on a store without the capability and capabilities say so", async () => {
    const c = await setup(false);
    await c.record("i1", "2024-03-10T12:10:00.000Z");
    const response = await c.get("/api/0/issues/i1/tags/");
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toMatch(
      /not supported by this store/,
    );
    const caps = (await (await c.get("/api/0/")).json()).errtraq.capabilities;
    expect([caps.issueStats, caps.tagFacets]).toEqual([false, false]);
  });
});
