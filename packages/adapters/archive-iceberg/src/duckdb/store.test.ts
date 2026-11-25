import type {
  Day,
  EventId,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "@moriyoshi/errtraq-core";
import { UnsupportedQueryError } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { configSchema } from "../stack.js";
import type { EngineSession } from "./session.js";
import { backoffDelay, DuckDbArchiveStore, isCommitConflict } from "./store.js";

const project = "p1" as ProjectId;
const range: [Day, Day] = ["2024-03-01" as Day, "2024-03-01" as Day];
const event = (
  id: string,
  receivedAt = "2024-03-01T10:00:00.000Z",
): StoredEvent => ({
  projectId: project,
  eventId: id as EventId,
  issueId: "i1" as StoredEvent["issueId"],
  timestamp: receivedAt as Timestamp,
  receivedAt: receivedAt as Timestamp,
  level: "error",
  tags: {},
  payload: {},
});

type Call = { sql: string; params: readonly unknown[] | undefined };
function fakeSession(
  handler: (call: Call) => Record<string, unknown>[] | Error,
) {
  const calls: Call[] = [];
  let closed = 0;
  const session: EngineSession = {
    async all(sql, params) {
      calls.push({ sql, params });
      const result = handler({ sql, params });
      if (result instanceof Error) throw result;
      return result;
    },
    async run(sql, params) {
      await this.all(sql, params);
    },
    close() {
      closed++;
    },
  };
  return { session, calls, closed: () => closed };
}
const config = (engine: object = {}) =>
  configSchema.parse({ catalog: { uri: "http://lk", warehouse: "w" }, engine })
    .engine;
function makeStore(
  handler: (call: Call) => Record<string, unknown>[] | Error,
  engine: object = {},
) {
  const fake = fakeSession(handler);
  const sleeps: number[] = [];
  const store = new DuckDbArchiveStore({
    namespace: "errtraq",
    engine: config({
      retry: { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 4 },
      ...engine,
    }),
    openSession: async () => fake.session,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
  });
  return { store, fake, sleeps };
}

describe("isCommitConflict", () => {
  it("recognizes lost optimistic commits and nothing else", () => {
    for (const message of [
      "Failed to commit: HTTP 409 Conflict",
      "CommitFailedException: Requirement failed: branch main has changed",
      "Iceberg commit conflict",
      "assert-ref-snapshot-id failed",
    ])
      expect(isCommitConflict(new Error(message))).toBe(true);
    for (const message of [
      "Catalog Error: Table does not exist",
      "IO Error: timeout",
      "HTTP 500",
    ])
      expect(isCommitConflict(new Error(message))).toBe(false);
  });
  it("backs off with full jitter, capped", () => {
    expect(backoffDelay(0, 100, 1000, () => 0.5)).toBe(50);
    expect(backoffDelay(3, 100, 1000, () => 0.5)).toBe(400);
    expect(backoffDelay(10, 100, 1000, () => 0.999)).toBe(999);
    expect(backoffDelay(2, 100, 1000, () => 0)).toBe(0);
  });
});

describe("capabilities", () => {
  it("reports the delete mode of the configured format version", () => {
    expect(makeStore(() => []).store.capabilities.rowDelete).toBe(
      "deletion-vector",
    );
    expect(
      makeStore(() => [], { formatVersion: 2 }).store.capabilities.rowDelete,
    ).toBe("position-delete");
  });
  it("rejects erasure operations until M4l", async () => {
    const { store } = makeStore(() => []);
    await expect(store.deleteWhere()).rejects.toBeInstanceOf(
      UnsupportedQueryError,
    );
    await expect(store.hardErase()).rejects.toBeInstanceOf(
      UnsupportedQueryError,
    );
    await expect(store.expireSnapshots()).rejects.toBeInstanceOf(
      UnsupportedQueryError,
    );
  });
});

describe("append", () => {
  it("rejects an empty batch without touching the engine", async () => {
    const { store, fake } = makeStore(() => []);
    await expect(
      store.append({ batchId: "b", dayRange: range, rows: [] }),
    ).rejects.toThrow(/Empty/);
    expect(fake.calls).toHaveLength(0);
  });

  it("probes, inserts once and reports the snapshot that holds the batch", async () => {
    let inserted = false;
    const { store, fake } = makeStore(({ sql }) => {
      if (sql.startsWith("INSERT")) {
        inserted = true;
        return [{ Count: "2" }];
      }
      if (sql.includes("iceberg_snapshots"))
        return [
          { snapshot_id: "10" },
          { snapshot_id: "20" },
          { snapshot_id: "30" },
        ];
      if (sql.includes("AT (VERSION =>"))
        return inserted && /VERSION => (20|30)\)/.test(sql)
          ? [{ found: 1 }]
          : [];
      // the plain probe, before the insert
      return inserted ? [{ found: 1 }] : [];
    });
    const result = await store.append({
      batchId: "b",
      dayRange: range,
      rows: [event("a"), event("b")],
    });
    expect(result).toEqual({ snapshotId: "20", rowCount: 2 });
    expect(fake.calls.filter((c) => c.sql.startsWith("INSERT"))).toHaveLength(
      1,
    );
  });

  it("does not insert a batch that is already committed", async () => {
    const { store, fake } = makeStore(({ sql }) => {
      if (sql.includes("iceberg_snapshots")) return [{ snapshot_id: "7" }];
      return [{ found: 1 }];
    });
    expect(
      await store.append({ batchId: "b", dayRange: range, rows: [event("a")] }),
    ).toEqual({ snapshotId: "7", rowCount: 1 });
    expect(fake.calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
  });

  it("retries a commit conflict with jittered backoff and re-probes before each attempt", async () => {
    let inserts = 0;
    let committed = false;
    const { store, fake, sleeps } = makeStore(({ sql }) => {
      if (sql.startsWith("INSERT")) {
        inserts++;
        if (inserts < 3) return new Error("HTTP 409 CommitFailedException");
        committed = true;
        return [{ Count: "1" }];
      }
      if (sql.includes("iceberg_snapshots")) return [{ snapshot_id: "5" }];
      return committed ? [{ found: 1 }] : [];
    });
    expect(
      await store.append({ batchId: "b", dayRange: range, rows: [event("a")] }),
    ).toEqual({ snapshotId: "5", rowCount: 1 });
    expect(inserts).toBe(3);
    expect(sleeps).toEqual([50, 100]);
    // probe, insert, probe, insert, probe, insert, then snapshot lookup and its probes
    expect(fake.calls.slice(0, 5).map((c) => c.sql.split(" ")[0])).toEqual([
      "SELECT",
      "INSERT",
      "SELECT",
      "INSERT",
      "SELECT",
    ]);
  });

  it("treats a conflicted insert that actually committed as done", async () => {
    let committed = false;
    const { store } = makeStore(({ sql }) => {
      if (sql.startsWith("INSERT")) {
        committed = true;
        return new Error("HTTP 409 (response lost)");
      }
      if (sql.includes("iceberg_snapshots")) return [{ snapshot_id: "9" }];
      return committed ? [{ found: 1 }] : [];
    });
    expect(
      await store.append({ batchId: "b", dayRange: range, rows: [event("a")] }),
    ).toEqual({ snapshotId: "9", rowCount: 1 });
  });

  it("gives up after maxAttempts conflicts and never retries other errors", async () => {
    let inserts = 0;
    const conflicted = makeStore(({ sql }) => {
      if (sql.startsWith("INSERT")) {
        inserts++;
        return new Error("HTTP 409");
      }
      return [];
    });
    await expect(
      conflicted.store.append({
        batchId: "b",
        dayRange: range,
        rows: [event("a")],
      }),
    ).rejects.toThrow(/409/);
    expect(inserts).toBe(4);
    let others = 0;
    const broken = makeStore(({ sql }) => {
      if (sql.startsWith("INSERT")) {
        others++;
        return new Error("IO Error: disk full");
      }
      return [];
    });
    await expect(
      broken.store.append({
        batchId: "b",
        dayRange: range,
        rows: [event("a")],
      }),
    ).rejects.toThrow(/disk full/);
    expect(others).toBe(1);
  });

  it("serializes concurrent appends of one batch into a single insert", async () => {
    let committed = false;
    let inserts = 0;
    const { store } = makeStore(({ sql }) => {
      if (sql.startsWith("INSERT")) {
        inserts++;
        committed = true;
        return [{ Count: "1" }];
      }
      if (sql.includes("iceberg_snapshots")) return [{ snapshot_id: "4" }];
      return committed ? [{ found: 1 }] : [];
    });
    const batch = { batchId: "b", dayRange: range, rows: [event("a")] };
    const [x, y] = await Promise.all([
      store.append(batch),
      store.append(batch),
    ]);
    expect(x).toEqual(y);
    expect(inserts).toBe(1);
  });
});

describe("reads", () => {
  it("answers hasBatch from the pruned probe", async () => {
    const hit = makeStore(() => [{ found: 1 }]);
    expect(await hit.store.hasBatch("b", range)).toBe(true);
    expect(hit.fake.calls[0]?.params).toEqual([
      "b",
      "2024-03-01T00:00:00.000Z",
      "2024-03-02T00:00:00.000Z",
    ]);
    expect(await makeStore(() => []).store.hasBatch("b", range)).toBe(false);
  });

  it("lists batch event ids", async () => {
    const { store } = makeStore(() => [{ event_id: "a" }, { event_id: "b" }]);
    expect(await store.batchEventIds(project, "b", range)).toEqual(["a", "b"]);
  });

  it("pages with limit + 1 and a keyset cursor", async () => {
    const rows = ["a", "b", "c"].map((id) => ({
      event: JSON.stringify(event(id)),
    }));
    const { store, fake } = makeStore(() => rows);
    const page = await store.query({
      projectId: project,
      limit: 2,
      order: "asc",
    });
    expect(page.items.map((e) => e.eventId)).toEqual(["a", "b"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    expect(fake.calls[0]?.params?.at(-1)).toBe(3);
    const next = await store.query({
      projectId: project,
      limit: 2,
      order: "asc",
      ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
    });
    expect(next.items.length).toBeGreaterThan(0);
    expect(fake.calls[1]?.params).toContain("b");
    const last = makeStore(() => rows.slice(0, 2));
    expect(
      await last.store.query({ projectId: project, limit: 2 }),
    ).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
  });

  it("rejects a cursor from another query", async () => {
    const { store } = makeStore(() => []);
    await expect(
      store.query({ projectId: project, cursor: "garbage" as never }),
    ).rejects.toThrow();
  });

  it("finds an event with the hint day first and falls back without it", async () => {
    const found = event("e1");
    const { store, fake } = makeStore(({ params }) =>
      (params?.length ?? 0) > 2 ? [] : [{ event: JSON.stringify(found) }],
    );
    expect(
      await store.getEvent(
        project,
        "e1" as EventId,
        "2024-05-05T00:00:00.000Z" as Timestamp,
      ),
    ).toEqual(found);
    expect(fake.calls).toHaveLength(2);
    expect(
      await makeStore(() => []).store.getEvent(project, "x" as EventId),
    ).toBeNull();
  });
});

describe("ensureTable", () => {
  it("skips an existing table", async () => {
    const { store, fake } = makeStore(() => [{ c: "1" }]);
    expect(await store.ensureTable()).toEqual({ created: false });
    expect(fake.calls).toHaveLength(1);
    expect(fake.closed()).toBe(1);
  });
  it("runs the DDL in order in its own session and closes it", async () => {
    const { store, fake } = makeStore(({ sql }) =>
      sql.includes("duckdb_tables") ? [{ c: "0" }] : [],
    );
    expect(await store.ensureTable()).toEqual({ created: true });
    expect(
      fake.calls.map((c) => c.sql.split(" ").slice(0, 2).join(" ")),
    ).toEqual([
      "SELECT count(*)",
      "CREATE SCHEMA",
      "CREATE TABLE",
      "ALTER TABLE",
      "ALTER TABLE",
      "ALTER TABLE",
    ]);
    expect(fake.closed()).toBe(1);
  });
  it("closes its session when the DDL fails", async () => {
    const { store, fake } = makeStore(({ sql }) =>
      sql.includes("duckdb_tables") ? [{ c: "0" }] : new Error("boom"),
    );
    await expect(store.ensureTable()).rejects.toThrow("boom");
    expect(fake.closed()).toBe(1);
  });
});
