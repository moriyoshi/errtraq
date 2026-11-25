import type { Day, ProjectId } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { configSchema } from "../stack.js";
import { expiryMs, isS3AuthFailure, redactCredentials } from "./recovery.js";
import type { EngineSession } from "./session.js";
import { DuckDbArchiveStore } from "./store.js";

const range: [Day, Day] = ["2024-03-01" as Day, "2024-03-01" as Day];
const engine = configSchema.parse({
  catalog: { uri: "http://lk", warehouse: "w" },
}).engine;

interface Fake {
  session: EngineSession;
  sql: string[];
  refreshes: number;
  closed: number;
  expiresAt: number | undefined;
}
function fake(
  handler: (sql: string, n: number) => Record<string, unknown>[] | Error,
  expiresAt?: number,
): Fake {
  const state: Fake = {
    sql: [],
    refreshes: 0,
    closed: 0,
    expiresAt,
    session: undefined as never,
  };
  let n = 0;
  state.session = {
    async all(sql) {
      state.sql.push(sql);
      const result = handler(sql, n++);
      if (result instanceof Error) throw result;
      return result;
    },
    async run(sql) {
      await this.all(sql);
    },
    close() {
      state.closed++;
    },
    credentialsExpireAt: () => state.expiresAt,
    async refreshCredentials() {
      state.refreshes++;
      state.expiresAt = undefined;
    },
  };
  return state;
}
const forbidden = new Error(
  "HTTP Error: HTTP GET error on 'http://s3/x' (HTTP 403)\n<Error><Code>ExpiredToken</Code></Error>",
);
function storeOf(sessions: Fake[], now = () => 0) {
  let opened = 0;
  return {
    store: new DuckDbArchiveStore({
      namespace: "errtraq",
      engine,
      openSession: async () => {
        const next = sessions[opened++];
        if (!next) throw new Error("no more sessions");
        return next.session;
      },
      now,
    }),
    opened: () => opened,
  };
}

describe("classifiers", () => {
  it("matches S3 authentication failures conservatively", () => {
    expect(isS3AuthFailure(forbidden)).toBe(true);
    expect(isS3AuthFailure(new Error("... InvalidAccessKeyId ..."))).toBe(true);
    expect(
      isS3AuthFailure(
        new Error("The security token included in the request is expired"),
      ),
    ).toBe(true);
    for (const message of [
      "Catalog Error: Table does not exist",
      "HTTP 409 Conflict",
      "Binder Error: column 4030 not found",
      "IO Error: timeout",
    ])
      expect(isS3AuthFailure(new Error(message))).toBe(false);
  });
  it("normalizes expiry values", () => {
    expect(expiryMs(undefined)).toBeUndefined();
    expect(expiryMs(5)).toBe(5);
    expect(expiryMs(new Date(7))).toBe(7);
    expect(expiryMs("1970-01-01T00:00:01.000Z")).toBe(1000);
    expect(expiryMs("garbage")).toBeUndefined();
  });
  it("redacts credential values", () => {
    const text = redactCredentials("bad KEY_ID 'AK' SECRET 'sk' TOKEN tk", {
      accessKeyId: "AK",
      secretAccessKey: "sk",
      sessionToken: "tk",
    });
    expect(text).not.toMatch(/AK|sk|tk/);
  });
});

describe("credential refresh", () => {
  it("renews the secret before it expires, not before", async () => {
    const a = fake(() => [], 10 * 60_000);
    let clock = 0;
    const { store } = storeOf([a], () => clock);
    await store.hasBatch("b", range);
    expect(a.refreshes).toBe(0);
    clock = 6 * 60_000; // inside the 5 minute skew of the 10 minute expiry
    await store.hasBatch("b", range);
    expect(a.refreshes).toBe(1);
    await store.hasBatch("b", range);
    expect(a.refreshes).toBe(1);
  });
  it("renews on an S3 authentication failure and repeats a read once", async () => {
    let failed = false;
    const a = fake((sql) => {
      if (sql.includes("archive_batch") && !failed) {
        failed = true;
        return forbidden;
      }
      return [{ one: 1 }];
    });
    const { store } = storeOf([a]);
    expect(await store.hasBatch("b", range)).toBe(true);
    expect(a.refreshes).toBe(1);
  });
  it("gives up after the one retry and throws the S3 error", async () => {
    const a = fake((sql) => (sql === "SELECT 1" ? [] : forbidden));
    const { store } = storeOf([a]);
    await expect(store.hasBatch("b", range)).rejects.toBe(forbidden);
    expect(a.refreshes).toBe(1);
    expect(a.closed).toBe(0); // the connection still answers, so the session is kept
  });
  it("does not repeat or renew for other errors", async () => {
    const a = fake((sql) =>
      sql === "SELECT 1" ? [] : new Error("Binder Error: nope"),
    );
    const { store } = storeOf([a]);
    await expect(store.hasBatch("b", range)).rejects.toThrow("Binder Error");
    expect(a.refreshes).toBe(0);
  });
  it("append re-probes before the INSERT that follows a renewal", async () => {
    let inserts = 0;
    const a = fake((sql) => {
      if (sql.startsWith("INSERT") && inserts++ === 0) return forbidden;
      if (sql.includes("iceberg_snapshots")) return [{ snapshot_id: "1" }];
      if (sql.includes("archive_batch")) return inserts > 0 ? [{ one: 1 }] : [];
      return [];
    });
    const { store } = storeOf([a]);
    const row = {
      projectId: "p" as ProjectId,
      eventId: "e",
      issueId: "i",
      timestamp: "2024-03-01T10:00:00.000Z",
      receivedAt: "2024-03-01T10:00:00.000Z",
      level: "error",
      tags: {},
      payload: {},
    } as never;
    await store.append({ batchId: "b", dayRange: range, rows: [row] });
    expect(a.refreshes).toBe(1);
    expect(inserts).toBe(1); // the second attempt saw the batch and did not INSERT again
  });
});

describe("session reopen", () => {
  it("discards a session that no longer answers and opens a fresh one", async () => {
    const dead = fake(() => new Error("FATAL Error: database invalidated"));
    const fresh = fake(() => [{ one: 1 }]);
    const { store, opened } = storeOf([dead, fresh]);
    await expect(store.hasBatch("b", range)).rejects.toThrow("FATAL Error");
    expect(dead.closed).toBe(1);
    expect(await store.hasBatch("b", range)).toBe(true);
    expect(opened()).toBe(2);
  });
  it("keeps a healthy session after an ordinary query error", async () => {
    const a = fake((sql, n) =>
      n === 0
        ? new Error("Binder Error: nope")
        : sql === "SELECT 1"
          ? []
          : [{ one: 1 }],
    );
    const { store, opened } = storeOf([a]);
    await expect(store.hasBatch("b", range)).rejects.toThrow("Binder Error");
    expect(await store.hasBatch("b", range)).toBe(true);
    expect(opened()).toBe(1);
    expect(a.closed).toBe(0);
  });
});
