import {
  type ActiveStore,
  type ArchiveStore,
  type Cursor,
  type EventId,
  type EventQuery,
  EventQueryService,
  InvalidCursorError,
  type IssueId,
  type ProjectId,
  type StoredEvent,
  summarizeBatch,
  type Timestamp,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { scenario } from "./archival.js";
import { FaultInjector, InjectedFault } from "./faults.js";
import { MemoryArchiveStore } from "./memory-other.js";

const projectId = "1" as ProjectId;
const BASE = Date.parse("2024-01-01T00:00:00.000Z");
const DAY = 86_400_000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function event(id: string, issue: string, ms: number): StoredEvent {
  const receivedAt = new Date(ms).toISOString() as Timestamp;
  return {
    projectId,
    eventId: id as EventId,
    issueId: issue as IssueId,
    timestamp: receivedAt,
    receivedAt,
    level: "error",
    tags: {},
    payload: { id },
  };
}

async function seedActive(store: ActiveStore, e: StoredEvent) {
  await store.recordEvent(
    {
      projectId,
      issueId: e.issueId,
      eventId: e.eventId,
      fingerprint: `fp-${e.issueId}`,
      timestamp: e.timestamp,
      receivedAt: e.receivedAt,
      title: "t",
      culprit: "",
      level: "error",
      type: "error",
      metadata: {},
    },
    e,
  );
}

const byKey = (a: StoredEvent, b: StoredEvent) =>
  a.receivedAt < b.receivedAt
    ? -1
    : a.receivedAt > b.receivedAt
      ? 1
      : a.eventId < b.eventId
        ? -1
        : a.eventId > b.eventId
          ? 1
          : 0;

interface World {
  store: ActiveStore;
  archive: MemoryArchiveStore;
  service: EventQueryService;
  /** Every distinct event, ascending. */
  all: StoredEvent[];
}

/** Random events over both tiers; some are in both (the archival DELETE-step window). */
async function world(
  factory: () => Promise<ActiveStore>,
  seed: number,
  withState = true,
): Promise<World> {
  const rand = rng(seed);
  const store = await factory();
  const archive = new MemoryArchiveStore();
  const count = 12 + Math.floor(rand() * 20);
  const ids = Array.from(
    { length: count },
    (_, i) => `e${String(i).padStart(3, "0")}`,
  );
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j] as string, ids[i] as string];
  }
  const all = ids.map((id) =>
    // few distinct instants so equal receivedAt ties are common
    event(
      id,
      rand() < 0.5 ? "i1" : "i2",
      BASE + Math.floor(rand() * 3) * DAY + Math.floor(rand() * 5) * 1000,
    ),
  );
  const cold: StoredEvent[] = [];
  for (const e of all) {
    const r = rand();
    if (r < 0.4 || r >= 0.8) await seedActive(store, e);
    if (r >= 0.4) cold.push(e);
  }
  for (let i = 0; i < cold.length; i += 5) {
    const rows = cold.slice(i, i + 5);
    await archive.append({
      batchId: `b${i}`,
      dayRange: summarizeBatch(rows).dayRange,
      rows,
    });
  }
  if (withState) {
    const max = cold.reduce(
      (m, e) => (e.receivedAt > m ? e.receivedAt : m),
      "",
    );
    await store.meta.compareAndSetArchiveState(projectId, null, {
      projectId,
      version: 0,
      archivedThrough: new Date(
        Date.parse(max || "2024-01-01") + 1,
      ).toISOString() as Timestamp,
      seq: 1,
    });
  }
  return {
    store,
    archive,
    service: new EventQueryService({ store, archive }),
    all: all.sort(byKey),
  };
}

function expected(
  all: StoredEvent[],
  q: Pick<EventQuery, "issueId" | "from" | "to" | "order">,
): EventId[] {
  const rows = all.filter(
    (e) =>
      (!q.issueId || e.issueId === q.issueId) &&
      (!q.from || e.receivedAt >= q.from) &&
      (!q.to || e.receivedAt < q.to),
  );
  if (q.order !== "asc") rows.reverse();
  return rows.map((e) => e.eventId);
}

/** Pages to the end through the public cursor only. */
async function pageAll(
  service: EventQueryService,
  q: EventQuery,
  between?: (pageIndex: number) => Promise<void>,
): Promise<{ ids: EventId[]; pages: number }> {
  const limit = q.limit ?? 100;
  const ids: EventId[] = [];
  let cursor: Cursor | undefined;
  for (let pages = 1; pages < 1000; pages++) {
    const page = await service.listByIssue({
      ...q,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    expect(page.hasMore).toBe(page.nextCursor !== null);
    ids.push(...page.items.map((e) => e.eventId));
    if (!page.hasMore) return { ids, pages };
    // A page that reports more is full, so hasMore cannot be a guess at a short page.
    expect(page.items).toHaveLength(limit);
    cursor = page.nextCursor ?? undefined;
    await between?.(pages);
  }
  throw new Error("pagination did not terminate");
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const LIMITS = [1, 2, 3, 7, 100];

/** The federation contract: run it with any active store; the archive is the in-memory fake. */
export function federationSuite(factory: () => Promise<ActiveStore>) {
  describe("federated event queries (M4c)", () => {
    it("pages equal the sorted, deduped union for random distributions, orders, limits and ranges", async () => {
      for (const seed of SEEDS) {
        const w = await world(factory, seed);
        const mid = w.all[Math.floor(w.all.length / 2)]?.receivedAt;
        const quarter = w.all[Math.floor(w.all.length / 4)]?.receivedAt;
        const ranges: Pick<EventQuery, "issueId" | "from" | "to">[] = [
          {},
          { issueId: "i1" as IssueId },
          ...(mid ? [{ from: mid }, { to: mid }] : []),
          ...(mid && quarter && quarter < mid
            ? [{ from: quarter, to: mid }]
            : []),
        ];
        for (const order of ["asc", "desc"] as const)
          for (const limit of LIMITS)
            for (const range of ranges) {
              const q: EventQuery = { projectId, order, limit, ...range };
              const { ids } = await pageAll(w.service, q);
              expect(
                ids,
                JSON.stringify({ seed, order, limit, range }),
              ).toEqual(expected(w.all, q));
            }
      }
    }, 120_000);

    it("defaults to newest first and reports hasMore exactly at the boundary", async () => {
      const w = await world(factory, 3);
      const total = w.all.length;
      const exact = await w.service.listByIssue({ projectId, limit: total });
      expect(exact.items).toHaveLength(total);
      expect(exact.hasMore).toBe(false);
      expect(exact.nextCursor).toBeNull();
      expect(exact.items.map((e) => e.eventId)).toEqual(
        expected(w.all, { order: "desc" }),
      );
      const short = await w.service.listByIssue({
        projectId,
        limit: total - 1,
      });
      expect(short.hasMore).toBe(true);
      const rest = await w.service.listByIssue({
        projectId,
        limit: total,
        cursor: short.nextCursor as Cursor,
      });
      expect(rest.items).toHaveLength(1);
      expect(rest.hasMore).toBe(false);
    });

    it("keeps paging when the active page is empty but archive rows remain, in both orders", async () => {
      for (const order of ["asc", "desc"] as const) {
        const store = await factory();
        const archive = new MemoryArchiveStore();
        // hot rows sit at the start of the traversal, cold rows after them
        const hot = [0, 1].map((i) => event(`h${i}`, "i1", BASE + i * 1000));
        const cold = [0, 1, 2].map((i) =>
          event(`c${i}`, "i1", BASE + DAY + i * 1000),
        );
        for (const e of hot) await seedActive(store, e);
        await archive.append({
          batchId: "b",
          dayRange: summarizeBatch(cold).dayRange,
          rows: cold,
        });
        await store.meta.compareAndSetArchiveState(projectId, null, {
          projectId,
          version: 0,
          archivedThrough: new Date(BASE + 2 * DAY).toISOString() as Timestamp,
          seq: 1,
        });
        const service = new EventQueryService({ store, archive });
        const first = [...hot, ...cold].sort(byKey);
        const want = (order === "asc" ? first : first.reverse()).map(
          (e) => e.eventId,
        );
        // desc: the active rows are consumed last, asc: first; either way one tier runs dry early
        const { ids } = await pageAll(service, { projectId, order, limit: 2 });
        expect(ids).toEqual(want);
        const only = await service.listByIssue({
          projectId,
          order,
          limit: 2,
          after: {
            receivedAt: hot[1]?.receivedAt as Timestamp,
            eventId: "h1" as EventId,
          },
        });
        expect(only.items.length).toBeGreaterThan(0);
      }
    });

    it("queries the archive only when the range starts below the watermark", async () => {
      const w = await world(factory, 5);
      const calls: string[] = [];
      const spy: ArchiveStore = new Proxy(w.archive, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "query")
            return typeof value === "function" ? value.bind(target) : value;
          return (...a: Parameters<ArchiveStore["query"]>) => {
            calls.push("query");
            return target.query(...a);
          };
        },
      });
      const service = new EventQueryService({ store: w.store, archive: spy });
      const state = await w.store.meta.getArchiveState(projectId);
      const through = state?.archivedThrough as Timestamp;
      await service.listByIssue({ projectId, limit: 5 });
      expect(calls.length).toBeGreaterThan(0);
      calls.length = 0;
      await service.listByIssue({ projectId, limit: 5, from: through });
      expect(calls).toEqual([]);
      await service.listByIssue({
        projectId,
        limit: 5,
        order: "asc",
        after: { receivedAt: through, eventId: "a" as EventId },
      });
      expect(calls).toEqual([]);
      const none = new EventQueryService({
        store: await factory(),
        archive: spy,
      });
      await none.listByIssue({ projectId, limit: 5 });
      expect(calls).toEqual([]);
    });

    it("stays gapless and duplicate-free while archival moves the watermark between pages", async () => {
      for (const order of ["asc", "desc"] as const)
        for (const limit of [1, 2, 3]) {
          const s = await scenario(factory, { old: 8 });
          const service = new EventQueryService({
            store: s.store,
            archive: s.archive,
          });
          const all = [...s.fixture.old, ...s.fixture.recent].sort(byKey);
          const want = (order === "asc" ? all : [...all].reverse()).map(
            (e) => e.eventId,
          );
          let progressed = 0;
          const { ids } = await pageAll(
            service,
            { projectId, order, limit },
            async () => {
              // one archival step per page: crash right after the first DELETE call, so rows
              // are then in both tiers and the watermark has already advanced
              s.clock.advance(130_000);
              const faults = new FaultInjector().arm({
                op: "events.deleteBatch",
                nth: 1,
                when: "after",
              });
              try {
                await s.worker({ faults }).run(projectId);
              } catch (error) {
                if (!(error instanceof InjectedFault)) throw error;
              }
              progressed++;
            },
          );
          expect(ids, `${order}/${limit}`).toEqual(want);
          expect(progressed).toBeGreaterThan(0);
          const state = await s.store.meta.getArchiveState(projectId);
          expect(state?.archivedThrough).not.toBe("1970-01-01T00:00:00.000Z");
        }
    }, 120_000);

    it("keeps the cursor to the federation boundary and rejects foreign or mismatched ones", async () => {
      const w = await world(factory, 2);
      const page = await w.service.listByIssue({ projectId, limit: 2 });
      const cursor = page.nextCursor as Cursor;
      const body = JSON.parse(
        atob(cursor.slice(3).replaceAll("-", "+").replaceAll("_", "/")),
      ) as [string, string[]];
      const last = page.items[1] as StoredEvent;
      expect(body[1]).toEqual([last.receivedAt, last.eventId]);
      expect(JSON.parse(body[0])[0]).toBe("fed");
      // source cursors would be scoped "events"; the public one must not carry them
      expect(
        atob(cursor.slice(3).replaceAll("-", "+").replaceAll("_", "/")),
      ).not.toContain("events");
      await expect(
        w.service.listByIssue({ projectId, limit: 2, order: "asc", cursor }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      await expect(
        w.service.listByIssue({
          projectId,
          limit: 2,
          issueId: "i1" as IssueId,
          cursor,
        }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      await expect(
        w.service.listByIssue({
          projectId,
          limit: 2,
          cursor: "v1.AAAA" as Cursor,
        }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      await expect(
        w.service.listByIssue({
          projectId,
          limit: 2,
          cursor,
          after: { receivedAt: last.receivedAt, eventId: last.eventId },
        }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      // a cursor from the active store is not a federation cursor either
      const source = await w.store.events.listByIssue({ projectId, limit: 1 });
      if (source.nextCursor)
        await expect(
          w.service.listByIssue({
            projectId,
            limit: 2,
            cursor: source.nextCursor,
          }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
    });

    it("works without an ArchiveState and ignores an archive-only row beyond the watermark", async () => {
      const w = await world(factory, 4, false);
      // active rows still all appear; cold-only rows are not reachable without a watermark
      const { ids } = await pageAll(w.service, { projectId, limit: 3 });
      const active = new Set<EventId>();
      let cursor: Cursor | undefined;
      do {
        const p = await w.store.events.listByIssue({
          projectId,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        for (const e of p.items) active.add(e.eventId);
        cursor = p.nextCursor ?? undefined;
      } while (cursor);
      expect(new Set(ids)).toEqual(active);
    });

    it("getEvent reads the active store first, then the archive with the hint", async () => {
      const w = await world(factory, 6);
      const hints: (Timestamp | undefined)[] = [];
      const spy = new Proxy(w.archive, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "getEvent")
            return typeof value === "function" ? value.bind(target) : value;
          return (...a: Parameters<ArchiveStore["getEvent"]>) => {
            hints.push(a[2]);
            return target.getEvent(...a);
          };
        },
      });
      const service = new EventQueryService({ store: w.store, archive: spy });
      for (const e of w.all) {
        const got = await service.getEvent(projectId, e.eventId, e.receivedAt);
        expect(got?.eventId).toBe(e.eventId);
      }
      expect(hints.every((h) => h !== undefined)).toBe(true);
      expect(await service.getEvent(projectId, "nope" as EventId)).toBeNull();
    });
  });
}
