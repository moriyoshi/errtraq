import {
  type ActiveStore,
  type Cursor,
  type EventId,
  type IssueId,
  type Occurrence,
  type ProjectId,
  type RecordInput,
  type StoredEvent,
  type Timestamp,
  UnsupportedQueryError,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";

type Factory<T> = () => T | Promise<T>;

const project = "1" as ProjectId;
const otherProject = "2" as ProjectId;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const base = Date.UTC(2024, 2, 10, 0, 0, 0);
/** Timestamp `hours` hours (and `ms` milliseconds) after the fixed base hour. */
const at = (hours: number, ms = 0): Timestamp =>
  new Date(base + hours * HOUR + ms).toISOString() as Timestamp;

let counter = 0;
function input(
  issue: string,
  receivedAt: Timestamp,
  extra: Partial<StoredEvent> = {},
  id = `s-${++counter}`,
  projectId: ProjectId = project,
): RecordInput {
  const occurrence: Occurrence = {
    projectId,
    issueId: issue as IssueId,
    eventId: id as EventId,
    fingerprint: issue,
    receivedAt,
    timestamp: receivedAt,
    title: "title",
    culprit: "culprit",
    level: "error",
    type: "error",
    metadata: {},
  };
  const event: StoredEvent = {
    projectId,
    eventId: id as EventId,
    issueId: issue as IssueId,
    timestamp: receivedAt,
    receivedAt,
    level: "error",
    tags: {},
    payload: { id },
    ...extra,
  };
  return { occurrence, event };
}
const put = (store: ActiveStore, item: RecordInput) =>
  store.recordEvent(item.occurrence, item.event);

async function allValues(
  store: ActiveStore,
  issue: string,
  key: Parameters<NonNullable<ActiveStore["stats"]>["tagValues"]>[2],
  limit: number,
  projectId: ProjectId = project,
) {
  const rows: Array<{ value: string; count: number }> = [];
  const seen = new Set<Cursor>();
  let cursor: Cursor | undefined;
  do {
    const page = await (
      store.stats as NonNullable<ActiveStore["stats"]>
    ).tagValues(projectId, issue as IssueId, key, { cursor, limit });
    rows.push(...page.items);
    if (page.nextCursor) {
      if (seen.has(page.nextCursor)) throw new Error("Cursor repeated");
      seen.add(page.nextCursor);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}
const series = async (
  store: ActiveStore,
  issue: string,
  from: Timestamp,
  to: Timestamp,
  projectId: ProjectId = project,
) => {
  const result = await (
    store.stats as NonNullable<ActiveStore["stats"]>
  ).series(projectId, [issue as IssueId], { from, to });
  return result[0]?.buckets.map((b) => [b.hour, b.count]);
};

/** Hourly counts and tag facets (UI-d). Capability-gated: a store declaring false only has to reject. */
export function issueStatsContract(factory: Factory<ActiveStore>): void {
  describe("issue statistics", () => {
    it("declares the capabilities and rejects when they are false", async () => {
      const store = await factory();
      const caps = store.capabilities;
      expect(["boolean", "undefined"]).toContain(typeof caps.issueStats);
      expect(["boolean", "undefined"]).toContain(typeof caps.tagFacets);
      if (caps.issueStats && caps.tagFacets) {
        expect(store.stats).toBeDefined();
        return;
      }
      if (!store.stats) return;
      if (!caps.issueStats)
        await expect(
          store.stats.series(project, [], { from: at(0), to: at(1) }),
        ).rejects.toBeInstanceOf(UnsupportedQueryError);
      if (!caps.tagFacets) {
        await expect(
          store.stats.tagFacets(project, "i" as IssueId, { limit: 5 }),
        ).rejects.toBeInstanceOf(UnsupportedQueryError);
        await expect(
          store.stats.tagValues(project, "i" as IssueId, "level"),
        ).rejects.toBeInstanceOf(UnsupportedQueryError);
      }
    });

    it("counts accepted insertions per UTC receivedAt hour and ignores duplicates", async () => {
      const store = await factory();
      if (!store.capabilities.issueStats) return;
      const a = input("st-a", at(1, 10), {}, "a1");
      await put(store, a);
      await put(store, input("st-a", at(1, 20), {}, "a2"));
      await put(store, input("st-a", at(3, 0), {}, "a3"));
      // A redelivery of an existing event changes nothing, neither the issue nor a bucket.
      expect((await put(store, a)).inserted).toBe(false);
      expect(await series(store, "st-a", at(0), at(24))).toEqual([
        [at(1), 2],
        [at(3), 1],
      ]);
      expect((await store.issues.get(project, "st-a" as IssueId))?.count).toBe(
        3,
      );
      // Another issue and another project never share counters.
      await put(store, input("st-b", at(1), {}, "b1"));
      await put(store, input("st-a", at(1), {}, "p2a", otherProject));
      expect(await series(store, "st-a", at(0), at(24))).toEqual([
        [at(1), 2],
        [at(3), 1],
      ]);
      expect(await series(store, "st-b", at(0), at(24))).toEqual([[at(1), 1]]);
      expect(await series(store, "st-a", at(0), at(24), otherProject)).toEqual([
        [at(1), 1],
      ]);
    });

    it("uses receivedAt, not the SDK timestamp, and honours bucket boundaries", async () => {
      const store = await factory();
      if (!store.capabilities.issueStats) return;
      await put(
        store,
        input("st-edge", at(5, -1), { timestamp: at(100) }, "e1"),
      );
      await put(store, input("st-edge", at(5), {}, "e2"));
      await put(store, input("st-edge", at(6, -1), {}, "e3"));
      await put(store, input("st-edge", at(6), {}, "e4"));
      expect(await series(store, "st-edge", at(0), at(24))).toEqual([
        [at(4), 1],
        [at(5), 2],
        [at(6), 1],
      ]);
      // [from, to): from inclusive, to exclusive, on the bucket's hour start.
      expect(await series(store, "st-edge", at(5), at(6))).toEqual([
        [at(5), 2],
      ]);
      expect(await series(store, "st-edge", at(5), at(5))).toEqual([]);
      expect(await series(store, "st-edge", at(7), at(30))).toEqual([]);
    });

    it("rejects more than 100 issues and a range over 31 days", async () => {
      const store = await factory();
      if (!store.capabilities.issueStats || !store.stats) return;
      const ids = Array.from({ length: 100 }, (_, i) => `x${i}` as IssueId);
      const ok = await store.stats.series(project, ids, {
        from: at(0),
        to: at(24),
      });
      expect(ok).toHaveLength(100);
      expect(ok.every((row) => row.buckets.length === 0)).toBe(true);
      await expect(
        store.stats.series(project, [...ids, "x100" as IssueId], {
          from: at(0),
          to: at(24),
        }),
      ).rejects.toBeInstanceOf(RangeError);
      const edge = new Date(base + 31 * DAY).toISOString() as Timestamp;
      const over = new Date(base + 31 * DAY + 1).toISOString() as Timestamp;
      await expect(
        store.stats.series(project, ["x" as IssueId], {
          from: at(0),
          to: edge,
        }),
      ).resolves.toHaveLength(1);
      await expect(
        store.stats.series(project, ["x" as IssueId], {
          from: at(0),
          to: over,
        }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        store.stats.series(project, ["x" as IssueId], {
          from: at(2),
          to: at(1),
        }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        store.stats.series(project, ["x" as IssueId], {
          from: "yesterday" as Timestamp,
          to: at(1),
        }),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it("returns one row per distinct requested issue in request order", async () => {
      const store = await factory();
      if (!store.capabilities.issueStats || !store.stats) return;
      await put(store, input("st-1", at(1), {}, "o1"));
      await put(store, input("st-2", at(2), {}, "o2"));
      const rows = await store.stats.series(
        project,
        ["st-2", "st-1", "st-2", "st-none"] as IssueId[],
        { from: at(0), to: at(24) },
      );
      expect(rows.map((r) => r.issueId)).toEqual(["st-2", "st-1", "st-none"]);
      expect(rows.map((r) => r.buckets.length)).toEqual([1, 1, 0]);
    });

    it("follows recordEvents: duplicates, in-group duplicates, mixed groups and two issues", async () => {
      const store = await factory();
      if (!store.capabilities.issueStats || !store.capabilities.recordEvents)
        return;
      const g1 = [
        input("st-g", at(1), {}, "g1"),
        input("st-g", at(1, 5), {}, "g2"),
        input("st-g", at(2), {}, "g3"),
      ];
      // g1 repeated inside the group counts once.
      await store.recordEvents([...g1, g1[0] as RecordInput]);
      expect(await series(store, "st-g", at(0), at(24))).toEqual([
        [at(1), 2],
        [at(2), 1],
      ]);
      // A mixed group: g2 is an existing duplicate, g4 and g5 are new.
      await store.recordEvents([
        g1[1] as RecordInput,
        input("st-g", at(2, 1), {}, "g4"),
        input("st-g", at(9), {}, "g5"),
      ]);
      expect(await series(store, "st-g", at(0), at(24))).toEqual([
        [at(1), 2],
        [at(2), 2],
        [at(9), 1],
      ]);
      // A group of only duplicates changes nothing.
      await store.recordEvents(g1);
      expect((await store.issues.get(project, "st-g" as IssueId))?.count).toBe(
        5,
      );
      expect(
        (await series(store, "st-g", at(0), at(24)))?.reduce(
          (n, [, c]) => n + (c as number),
          0,
        ),
      ).toBe(5);
      // A second issue recorded alongside keeps its own counters.
      await store.recordEvents([input("st-h", at(1), {}, "h1")]);
      expect(await series(store, "st-h", at(0), at(24))).toEqual([[at(1), 1]]);
    });

    it("adds nothing when a group is rejected", async () => {
      const store = await factory();
      if (!store.capabilities.issueStats || !store.capabilities.recordEvents)
        return;
      const good = input("st-r", at(1), { tags: { "os.name": "Linux" } }, "r1");
      const bad = input("st-r", at(1), {}, "r2");
      bad.occurrence = { ...bad.occurrence, fingerprint: "other" };
      await expect(store.recordEvents([good, bad])).rejects.toThrow();
      expect(await series(store, "st-r", at(0), at(24))).toEqual([]);
      expect(
        await store.stats?.tagFacets(project, "st-r" as IssueId, { limit: 3 }),
      ).toEqual([]);
    });

    it("keeps a full-width group correct: ten events, ten days, every facet key each", async () => {
      const store = await factory();
      if (!store.capabilities.issueStats || !store.capabilities.recordEvents)
        return;
      const levels = [
        "fatal",
        "error",
        "warning",
        "info",
        "debug",
        "fatal",
        "error",
        "warning",
        "info",
        "debug",
      ] as const;
      const group = levels.map((level, i) =>
        input(
          "st-w",
          at(i * 30, 7),
          {
            level,
            environment: `env-${i}`,
            release: `rel-${i}`,
            tags: {
              server_name: `srv-${i}`,
              "browser.name": `br-${i}`,
              "os.name": `os-${i}`,
              "runtime.name": `rt-${i}`,
            },
          },
          `w${i}`,
        ),
      );
      const results = await store.recordEvents(group);
      expect(results.every((r) => r.inserted)).toBe(true);
      // Ten distinct UTC days: the widest fan-out of buckets one group can have.
      const buckets = await series(store, "st-w", at(0), at(10 * 30));
      expect(buckets).toHaveLength(10);
      expect(buckets?.every(([, c]) => c === 1)).toBe(true);
      const facets = await store.stats?.tagFacets(project, "st-w" as IssueId, {
        limit: 10,
      });
      expect(facets?.map((f) => f.key)).toEqual([
        "level",
        "environment",
        "release",
        "server_name",
        "browser.name",
        "os.name",
        "runtime.name",
      ]);
      expect(facets?.map((f) => f.totalValues)).toEqual([
        5, 10, 10, 10, 10, 10, 10,
      ]);
      expect(facets?.map((f) => f.totalCount)).toEqual([
        10, 10, 10, 10, 10, 10, 10,
      ]);
      // The same group again is all duplicates: nothing changes.
      await store.recordEvents(group);
      expect(
        (
          await store.stats?.tagFacets(project, "st-w" as IssueId, {
            limit: 10,
          })
        )?.map((f) => f.totalCount),
      ).toEqual([10, 10, 10, 10, 10, 10, 10]);
    });

    it("stays exact under concurrent groups for one issue", async () => {
      const store = await factory();
      if (!store.capabilities.issueStats || !store.capabilities.recordEvents)
        return;
      const groups = Array.from({ length: 4 }, (_, g) =>
        Array.from({ length: 10 }, (_, i) =>
          input(
            "st-c",
            at(i % 3, g),
            { environment: g % 2 ? "prod" : "dev" },
            `c-${g}-${i}`,
          ),
        ),
      );
      await Promise.all(groups.map((g) => store.recordEvents(g)));
      const total = (await series(store, "st-c", at(0), at(24)))?.reduce(
        (n, [, c]) => n + (c as number),
        0,
      );
      expect(total).toBe(40);
      const env = (
        await store.stats?.tagFacets(project, "st-c" as IssueId, { limit: 5 })
      )?.find((f) => f.key === "environment");
      expect(env?.topValues).toEqual([
        { value: "dev", count: 20 },
        { value: "prod", count: 20 },
      ]);
      expect(env?.totalCount).toBe(40);
    });

    it("ranks facet values by count then value and summarizes each key", async () => {
      const store = await factory();
      if (!store.capabilities.tagFacets || !store.stats) return;
      const rows: Array<[string, string]> = [
        ["prod", "1.0"],
        ["prod", "1.0"],
        ["prod", "1.1"],
        ["staging", "1.1"],
        ["staging", "1.1"],
        ["staging", "1.1"],
        ["dev", "1.0"],
      ];
      let n = 0;
      for (const [environment, release] of rows)
        await put(
          store,
          input(
            "st-t",
            at(1),
            { environment, release, level: "warning" },
            `t${n++}`,
          ),
        );
      const facets = await store.stats.tagFacets(project, "st-t" as IssueId, {
        limit: 2,
      });
      const byKey = Object.fromEntries(facets.map((f) => [f.key, f]));
      expect(byKey.environment).toEqual({
        key: "environment",
        totalValues: 3,
        totalCount: 7,
        topValues: [
          { value: "prod", count: 3 },
          { value: "staging", count: 3 },
        ],
      });
      expect(byKey.release?.topValues).toEqual([
        { value: "1.1", count: 4 },
        { value: "1.0", count: 3 },
      ]);
      expect(byKey.level).toEqual({
        key: "level",
        totalValues: 1,
        totalCount: 7,
        topValues: [{ value: "warning", count: 7 }],
      });
      // Keys with no values are omitted; allow-list order is kept.
      expect(facets.map((f) => f.key)).toEqual([
        "level",
        "environment",
        "release",
      ]);
      await expect(
        store.stats.tagFacets(project, "st-t" as IssueId, { limit: 0 }),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        store.stats.tagFacets(project, "st-t" as IssueId, { limit: 11 }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(
        await store.stats.tagFacets(project, "st-none" as IssueId, {
          limit: 3,
        }),
      ).toEqual([]);
    });

    it("counts only allow-listed keys and never personal data", async () => {
      const store = await factory();
      if (!store.capabilities.tagFacets || !store.stats) return;
      await put(
        store,
        input(
          "st-p",
          at(1),
          {
            tags: {
              "user.email": "someone@example.com",
              "user.id": "42",
              user: "someone",
              url: "https://example.com/private?token=1",
              ip: "203.0.113.9",
              "browser.name": "Firefox",
              "browser.version": "130",
              level: "fatal",
              environment: "from-tag",
            },
            user: {
              id: "42",
              email: "someone@example.com",
              ipAddress: "203.0.113.9",
            },
          },
          "p1",
        ),
      );
      const facets = await store.stats.tagFacets(project, "st-p" as IssueId, {
        limit: 10,
      });
      // Fields win over same-named tags; only the allow-list is counted.
      expect(facets.map((f) => [f.key, f.topValues])).toEqual([
        ["level", [{ value: "error", count: 1 }]],
        ["browser.name", [{ value: "Firefox", count: 1 }]],
      ]);
      expect(JSON.stringify(facets)).not.toMatch(/someone|203\.0|private|"42"/);
      await expect(
        store.stats.tagValues(
          project,
          "st-p" as IssueId,
          "user.email" as never,
        ),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        store.stats.tagValues(project, "st-p" as IssueId, "url" as never),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it("truncates values to 200 characters and skips empty ones", async () => {
      const store = await factory();
      if (!store.capabilities.tagFacets || !store.stats) return;
      await put(
        store,
        input(
          "st-l",
          at(1),
          { tags: { server_name: "r".repeat(300), "os.name": "" } },
          "l1",
        ),
      );
      await put(
        store,
        input(
          "st-l",
          at(1),
          { tags: { server_name: `${"r".repeat(200)}tail` } },
          "l2",
        ),
      );
      // 200 characters of a 3-byte script are cut at 200 characters and then at the byte bound.
      await put(
        store,
        input(
          "st-l",
          at(1),
          { tags: { "runtime.name": "あ".repeat(250) } },
          "l3",
        ),
      );
      const facets = await store.stats.tagFacets(project, "st-l" as IssueId, {
        limit: 5,
      });
      const host = facets.find((f) => f.key === "server_name");
      // Both values share their first 200 characters, so they are one value.
      expect(host?.topValues).toEqual([{ value: "r".repeat(200), count: 2 }]);
      expect(facets.some((f) => f.key === "os.name")).toBe(false);
      const runtime = facets.find((f) => f.key === "runtime.name");
      expect(runtime?.topValues).toHaveLength(1);
      const kept = runtime?.topValues[0]?.value ?? "";
      expect(kept.length).toBeGreaterThan(0);
      expect(Array.from(kept).length).toBeLessThanOrEqual(200);
      expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(255);
      expect("あ".repeat(250).startsWith(kept)).toBe(true);
    });

    it("pages all values of a key by count then value", async () => {
      const store = await factory();
      if (!store.capabilities.tagFacets || !store.stats) return;
      const wanted: Array<{ value: string; count: number }> = [];
      let n = 0;
      for (let v = 0; v < 23; v++) {
        const count = (v % 4) + 1;
        const value = `host-${String(v).padStart(2, "0")}`;
        wanted.push({ value, count });
        for (let c = 0; c < count; c++)
          await put(
            store,
            input("st-v", at(1), { tags: { server_name: value } }, `v${n++}`),
          );
      }
      wanted.sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
      expect(await allValues(store, "st-v", "server_name", 5)).toEqual(wanted);
      expect(await allValues(store, "st-v", "server_name", 100)).toEqual(
        wanted,
      );
      expect(await allValues(store, "st-v", "os.name", 5)).toEqual([]);
      const top = (
        await store.stats.tagFacets(project, "st-v" as IssueId, { limit: 4 })
      ).find((f) => f.key === "server_name");
      expect(top?.topValues).toEqual(wanted.slice(0, 4));
      expect(top?.totalValues).toBe(23);
    });

    it("keeps counts after events are deleted and removes old buckets only on cleanup", async () => {
      const store = await factory();
      if (!store.capabilities.issueStats || !store.stats) return;
      await put(store, input("st-d", at(1), { environment: "prod" }, "d1"));
      await put(store, input("st-d", at(40), { environment: "prod" }, "d2"));
      await put(store, input("st-d", at(70), { environment: "prod" }, "d3"));
      await store.events.deleteBatch(project, ["d1", "d2", "d3"] as EventId[]);
      expect(await store.events.get(project, "d1" as EventId)).toBeNull();
      expect(await series(store, "st-d", at(0), at(100))).toEqual([
        [at(1), 1],
        [at(40), 1],
        [at(70), 1],
      ]);
      // Redelivery of a deleted event id is a fresh insertion (as for Issue.count).
      const cutoff = at(48);
      let hasMore = true;
      while (hasMore)
        hasMore = (
          await store.stats.deleteBefore(project, cutoff, { limit: 1 })
        ).hasMore;
      if (store.stats.expiry === "explicit")
        expect(await series(store, "st-d", at(0), at(100))).toEqual([
          [at(70), 1],
        ]);
      else
        expect((await series(store, "st-d", at(48), at(100)))?.length).toBe(1);
      // Facet counters never expire and never shrink.
      if (store.capabilities.tagFacets)
        expect(
          (
            await store.stats.tagFacets(project, "st-d" as IssueId, {
              limit: 3,
            })
          ).find((f) => f.key === "environment")?.topValues,
        ).toEqual([{ value: "prod", count: 3 }]);
      // Other projects are untouched.
      await put(store, input("st-d", at(1), {}, "d9", otherProject));
      await store.stats.deleteBefore(project, at(500));
      expect(await series(store, "st-d", at(0), at(24), otherProject)).toEqual([
        [at(1), 1],
      ]);
    });
  });
}
