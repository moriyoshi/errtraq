import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./fake.js";
import {
  decodeFields,
  encodeFields,
  FirestoreAbortedError,
  FirestoreAlreadyExistsError,
  FirestoreMissingIndexError,
  FirestoreRestClient,
  FirestoreThrottledError,
  FsTimestamp,
  isServed,
  type Query,
  shapeOfQuery,
} from "./index.js";

const client = (fake: FakeFirestore, extra = {}) =>
  new FirestoreRestClient({
    projectId: "test",
    endpoint: "http://127.0.0.1:1",
    fetch: fake.fetch,
    sleep: async () => {},
    ...extra,
  });

describe("value encoding", () => {
  it("round trips every supported type with integers as strings", () => {
    const input = {
      s: "é",
      i: 9007199254740991,
      d: 1.5,
      b: true,
      n: null,
      t: new FsTimestamp("2026-01-01T00:00:00.000Z"),
      bytes: new Uint8Array([0, 1, 255]),
      m: { a: [1, "x"] },
    };
    const fields = encodeFields({ ...input, skipped: undefined });
    expect(fields.i).toEqual({ integerValue: "9007199254740991" });
    expect(fields.d).toEqual({ doubleValue: 1.5 });
    expect("skipped" in fields).toBe(false);
    expect(decodeFields(fields)).toEqual(input);
    expect(() => encodeFields({ x: Number.NaN })).toThrow(RangeError);
  });
});

describe("REST client", () => {
  it("applies preconditions, masks and increment transforms", async () => {
    const fake = new FakeFirestore();
    const c = client(fake);
    await c.commit([
      { kind: "set", path: "kv/a", fields: encodeFields({ v: "1" }) },
    ]);
    await expect(
      c.commit([
        {
          kind: "set",
          path: "kv/a",
          fields: encodeFields({}),
          precondition: { exists: false },
        },
      ]),
    ).rejects.toBeInstanceOf(FirestoreAlreadyExistsError);
    const result = await c.commit([
      {
        kind: "set",
        path: "kv/a",
        fields: encodeFields({ c: true }),
        mask: ["c"],
        increments: [{ field: "n", by: 5 }],
      },
    ]);
    expect(result.writeResults[0]?.transformResults).toEqual([
      { integerValue: "5" },
    ]);
    const doc = await c.get("kv/a");
    expect(decodeFields(doc?.fields ?? {})).toEqual({ v: "1", c: true, n: 5 });
  });

  it("never sends the transaction id as a query parameter (emulator cannot decode bytes there)", async () => {
    const fake = new FakeFirestore();
    const urls: string[] = [];
    const c = client(fake, {
      fetch: (url: string, init?: RequestInit) => {
        urls.push(String(url));
        return fake.fetch(url, init);
      },
    });
    await c.commit([
      { kind: "set", path: "x/1", fields: encodeFields({ n: 0 }) },
    ]);
    const seen = await c.runTransaction(async (tx) => tx.get("x/1"));
    expect(seen).not.toBeNull();
    expect(urls.some((u) => u.includes("?"))).toBe(false);
    const read = fake.requests.find((r) => r.action === "batchGet");
    expect(
      (read?.body as { transaction?: string } | undefined)?.transaction,
    ).toEqual(expect.any(String));
  });

  it("fails fast on a server that never answers, without retrying the timeout", async () => {
    let calls = 0;
    const c = client(new FakeFirestore(), {
      requestTimeoutMs: 20,
      fetch: (_url: string, init?: RequestInit) => {
        calls++;
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        );
      },
    });
    await expect(c.get("x/1")).rejects.toMatchObject({
      status: "DEADLINE_EXCEEDED",
    });
    expect(calls).toBe(1);
  });

  it("retries an aborted transaction body and rolls back on failure", async () => {
    const fake = new FakeFirestore();
    const c = client(fake);
    await c.commit([
      { kind: "set", path: "x/1", fields: encodeFields({ n: 0 }) },
    ]);
    let runs = 0;
    await c.runTransaction(async (tx) => {
      runs++;
      const doc = await tx.get("x/1");
      if (runs < 3)
        await c.commit([
          { kind: "set", path: "x/1", fields: encodeFields({ n: runs }) },
        ]);
      await tx.commit([
        {
          kind: "set",
          path: "x/1",
          fields: encodeFields({ n: (doc ? 1 : 0) + 100 }),
        },
      ]);
    });
    expect(runs).toBe(3);
    await expect(
      c.runTransaction(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fake.requests.filter((r) => r.action === "rollback").length).toBe(1);
  });

  it("gives up with the aborted error when the attempt budget is spent", async () => {
    const fake = new FakeFirestore({
      intercept: (r) =>
        r.action === "commit"
          ? Response.json(
              { error: { code: 409, status: "ABORTED", message: "x" } },
              { status: 409 },
            )
          : undefined,
    });
    await expect(
      client(fake, { maxTransactionAttempts: 3 }).runTransaction((tx) =>
        tx.commit([]),
      ),
    ).rejects.toBeInstanceOf(FirestoreAbortedError);
    expect(
      fake.requests.filter((r) => r.action === "beginTransaction"),
    ).toHaveLength(3);
  });

  it("retries throttled requests with backoff and then surfaces them", async () => {
    let calls = 0;
    const fake = new FakeFirestore({
      intercept: (r) =>
        r.action === "get" && ++calls <= 2
          ? Response.json(
              {
                error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "" },
              },
              { status: 429 },
            )
          : undefined,
    });
    expect(await client(fake).get("a/b")).toBeNull();
    expect(calls).toBe(3);
    calls = -100;
    await expect(
      client(fake, { maxRequestRetries: 1 }).get("a/b"),
    ).rejects.toBeInstanceOf(FirestoreThrottledError);
  });

  it("maps a missing composite index to a configuration error naming it", async () => {
    const fake = new FakeFirestore({ indexes: [] });
    const query: Query = {
      parent: "",
      collection: "issues",
      where: [{ field: "status", op: "EQUAL", value: { stringValue: "a" } }],
      orderBy: [
        { field: "lastSeen", direction: "DESC" },
        { field: "__name__", direction: "ASC" },
      ],
    };
    const error = await client(fake)
      .runQuery(query)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FirestoreMissingIndexError);
    expect((error as Error).message).toContain(
      "issues: status ASC, lastSeen DESC, __name__ ASC",
    );
  });

  it("rejects an oversized document without sending it", async () => {
    const fake = new FakeFirestore();
    await expect(
      client(fake).commit([
        {
          kind: "set",
          path: "a/b",
          fields: encodeFields({ big: "x".repeat(1_048_576) }),
        },
      ]),
    ).rejects.toThrow("exceeds 1 MiB");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("index coverage model", () => {
  const shape = (q: Partial<Query>) =>
    shapeOfQuery({ parent: "", collection: "c", ...q });
  it("serves single-field queries automatically and demands composites otherwise", () => {
    expect(
      isServed(shape({ orderBy: [{ field: "a", direction: "ASC" }] }), []),
    ).toBe(true);
    expect(
      isServed(
        shape({
          orderBy: [
            { field: "a", direction: "DESC" },
            { field: "__name__", direction: "ASC" },
          ],
        }),
        [],
      ),
    ).toBe(false);
    expect(
      isServed(
        shape({
          where: [{ field: "e", op: "EQUAL", value: { stringValue: "x" } }],
          orderBy: [{ field: "a", direction: "ASC" }],
        }),
        [
          {
            collection: "c",
            fields: [
              { field: "e", direction: "ASC" },
              { field: "a", direction: "ASC" },
            ],
          },
        ],
      ),
    ).toBe(true);
  });
});
