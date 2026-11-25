import {
  InvalidCounterError,
  KVInvalidKeyError,
} from "@moriyoshi/errtraq-core/kv";
import { FirestoreRestClient } from "@moriyoshi/errtraq-firestore-rest";
import { FakeFirestore } from "@moriyoshi/errtraq-firestore-rest/fake";
import { FakeClock, kvContract } from "@moriyoshi/errtraq-testing";
import { describe, expect, it } from "vitest";
import { FirestoreKV } from "./runtime.js";
import { configSchema, infra, manifest } from "./stack.js";

let clock: FakeClock;
let fake: FakeFirestore;
function makeKV() {
  clock = new FakeClock("2090-01-01T00:00:00.000Z");
  fake = new FakeFirestore();
  return new FirestoreKV({
    clock,
    client: new FirestoreRestClient({
      projectId: "test",
      endpoint: "http://127.0.0.1:1",
      fetch: fake.fetch,
      sleep: async () => {},
    }),
    sleep: async () => {},
  });
}

describe("Firestore KV over the in-process fake", () => {
  kvContract(makeKV, { advance: (ms) => clock.advance(ms) });

  it("restarts an expired counter and keeps the creation TTL of a live one", async () => {
    const kv = makeKV();
    expect(await kv.increment("c", 2, { ttlSec: 10 })).toBe(2);
    clock.advance(5000);
    expect(await kv.increment("c", 3, { ttlSec: 100 })).toBe(5);
    clock.advance(5000);
    expect(await kv.get("c")).toBeNull();
    expect(fake.docs.has("kv/c")).toBe(true); // expired but not yet deleted by the TTL policy
    expect(await kv.increment("c", 7, { ttlSec: 20 })).toBe(7);
    clock.advance(20000);
    expect(await kv.get("c")).toBeNull();
  });

  it("does not add a TTL to an existing permanent counter and reads put decimals", async () => {
    const kv = makeKV();
    await kv.put("p", "0005");
    expect(await kv.get("p")).toBe("0005");
    expect(await kv.increment("p", 1, { ttlSec: 1 })).toBe(6);
    clock.advance(2000);
    expect(await kv.get("p")).toBe("6");
  });

  it("uses a field transform for live counters and sums concurrent increments", async () => {
    const kv = makeKV();
    await kv.increment("hot", 1);
    const results = await Promise.all(
      Array.from({ length: 40 }, () => kv.increment("hot", 1)),
    );
    expect(new Set(results).size).toBe(40);
    expect(await kv.get("hot")).toBe("41");
    const commits = fake.requests.filter((r) => r.action === "commit");
    expect(
      commits.some((c) =>
        JSON.stringify(c.body).includes('"increment":{"integerValue":"1"}'),
      ),
    ).toBe(true);
  });

  it("rejects a non-numeric value and an unsafe result", async () => {
    const kv = makeKV();
    await kv.put("s", "abc");
    await expect(kv.increment("s", 1)).rejects.toBeInstanceOf(
      InvalidCounterError,
    );
    await kv.put("m", String(Number.MAX_SAFE_INTEGER));
    await expect(kv.increment("m", 1)).rejects.toBeInstanceOf(
      InvalidCounterError,
    );
  });

  it("encodes arbitrary keys into legal path segments", async () => {
    const kv = makeKV();
    for (const key of ["a/b", ".", "..", "__x__", "日本語", "100%"]) {
      await kv.put(key, "v");
      expect(await kv.get(key)).toBe("v");
    }
    expect(fake.docs.has("kv/a%2Fb")).toBe(true);
    await expect(kv.get("")).rejects.toBeInstanceOf(KVInvalidKeyError);
    await expect(kv.get("x".repeat(1600))).rejects.toBeInstanceOf(
      KVInvalidKeyError,
    );
  });
});

describe("Firestore KV deployment configuration", () => {
  it("requires project and location, declares the TTL policy", () => {
    expect(configSchema.safeParse({ projectId: "p" }).success).toBe(false);
    expect(manifest.kind).toBe("kv");
    const inputs = infra.inputs(
      { projectId: "p", location: "l" },
      { functions: [], triggers: [] },
    );
    expect(inputs.purpose).toBe("kv");
    expect(inputs.ttl_policies).toEqual([
      { collection: "kv", field: "expireAt" },
    ]);
  });
});
