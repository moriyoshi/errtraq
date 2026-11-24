import {
  InvalidCounterError,
  KVAccessDeniedError,
  KVError,
  KVInvalidKeyError,
  KVThrottledError,
  KVUnavailableError,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it, vi } from "vitest";
import { create, DynamoKV } from "./runtime.js";

const env = {
  AWS_ACCESS_KEY_ID: "fixture",
  AWS_SECRET_ACCESS_KEY: "sensitive-secret",
  AWS_SESSION_TOKEN: "fixture-token",
};
const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const make = (fetcher: typeof fetch) =>
  new DynamoKV({
    table: "table",
    region: "us-east-1",
    environment: env,
    fetch: fetcher,
    sleep: async () => {},
    random: () => 0,
  });
describe("DynamoDB KV runtime", () => {
  it("validates keys and increments before network access", async () => {
    const fetcher = vi.fn();
    const kv = make(fetcher);
    for (const key of ["", "x".repeat(2046), "\ud800"])
      await expect(kv.get(key)).rejects.toBeInstanceOf(KVInvalidKeyError);
    await expect(kv.increment("x", 0.5)).rejects.toBeInstanceOf(
      InvalidCounterError,
    );
    await expect(kv.put("x", "v", { ttlSec: -1 })).rejects.toThrow("TTL");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rounds sub-millisecond TTL up for exact logical expiry", async () => {
    let item: Record<string, unknown> = {};
    const kv = new DynamoKV({
      table: "t",
      region: "us-east-1",
      environment: env,
      clock: { now: () => "2090-01-01T00:00:00.000Z" as never },
      fetch: async (_url, init) => {
        item = JSON.parse(String(init?.body)).Item;
        return json({});
      },
    });
    await kv.put("key", "value", { ttlSec: 0.0005 });
    expect(item.expiresMs).toEqual({ N: "3786912000001" });
    expect(item.expiresAt).toEqual({ N: "3786912001" });
  });
  it("uses consistent reads, ignores expired records and retains raw string values", async () => {
    let payload: Record<string, unknown> = {};
    const kv = new DynamoKV({
      table: "table",
      region: "us-east-1",
      environment: env,
      clock: { now: () => "2090-01-01T00:00:00.000Z" as never },
      fetch: async (_url, init) => {
        payload = JSON.parse(String(init?.body));
        return json({
          Item: {
            value: { S: "0005" },
            revision: { S: "r" },
            counter: { N: "5" },
            expiresMs: { N: "3786912000000" },
          },
        });
      },
    });
    expect(await kv.get("k")).toBeNull();
    expect(payload.ConsistentRead).toBe(true);
    expect(payload.Key).toEqual({ PK: { S: "KV#k" }, SK: { S: "KV" } });
  });
  it("maps provider errors without leaking provider messages or credentials", async () => {
    const kv = make(async () =>
      json(
        {
          __type: "com.amazonaws#AccessDeniedException",
          message: "sensitive-secret",
        },
        403,
      ),
    );
    const error = await kv.get("k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KVAccessDeniedError);
    expect(error).toMatchObject({ providerCode: "AccessDeniedException" });
    expect(String(error)).not.toContain("sensitive-secret");
  });
  it("retries throttling with jitter and Retry-After, then returns a typed failure", async () => {
    for (const code of [
      "ProvisionedThroughputExceededException",
      "ThrottlingException",
      "RequestLimitExceeded",
    ]) {
      const waits: number[] = [];
      let calls = 0;
      const kv = new DynamoKV({
        table: "t",
        region: "us-east-1",
        environment: env,
        random: () => 0.5,
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetch: async () => {
          calls++;
          return json({ __type: `com.amazonaws#${code}` }, 400, {
            "retry-after": "2",
          });
        },
      });
      const error = await kv.get("k").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KVThrottledError);
      expect(error).toMatchObject({ providerCode: code });
      expect(calls).toBe(4);
      expect(waits).toEqual([2000, 2000, 2000]);
    }
  });
  it("retries a server error with signed JSON and refreshed credentials", async () => {
    const environment = { ...env };
    const headers: Headers[] = [];
    const waits: number[] = [];
    const kv = new DynamoKV({
      table: "t",
      region: "us-east-1",
      environment,
      random: () => 0.5,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async (_url, init) => {
        headers.push(new Headers(init?.headers));
        environment.AWS_ACCESS_KEY_ID = "new-key";
        return headers.length === 1
          ? json({ __type: "InternalServerError" }, 503)
          : json({});
      },
    });
    expect(await kv.get("k")).toBeNull();
    expect(waits).toEqual([250]);
    expect(headers[0]?.get("x-amz-target")).toBe("DynamoDB_20120810.GetItem");
    expect(headers[0]?.get("x-amz-security-token")).toBe("fixture-token");
    expect(headers[1]?.get("authorization")).toContain("Credential=new-key/");
  });
  it("refreshes expired credentials exactly once", async () => {
    const environment = { ...env };
    const auth: string[] = [];
    // Use a live environment object to verify a fresh lookup.
    const rotating = new DynamoKV({
      table: "t",
      region: "us-east-1",
      environment,
      fetch: async (_url, init) => {
        auth.push(new Headers(init?.headers).get("authorization") ?? "");
        environment.AWS_ACCESS_KEY_ID = "rotated";
        return json({ __type: "ExpiredTokenException" }, 400);
      },
    });
    await expect(rotating.get("k")).rejects.toBeInstanceOf(KVError);
    expect(auth).toHaveLength(2);
    expect(auth[1]).toContain("Credential=rotated/");
  });
  it("aborts a hung request on each bounded attempt", async () => {
    const signals: AbortSignal[] = [];
    const kv = new DynamoKV({
      table: "t",
      region: "us-east-1",
      environment: env,
      requestTimeoutMs: 10,
      random: () => 0,
      sleep: async () => {},
      fetch: async (_url, init) => {
        if (init?.signal) signals.push(init.signal);
        return await new Promise<Response>(() => {});
      },
    });
    await expect(kv.get("k")).rejects.toBeInstanceOf(KVUnavailableError);
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it("rejects malformed and overflowing counters before update", async () => {
    let updates = 0;
    const kv = make(async (_url, init) => {
      const action = new Headers(init?.headers).get("x-amz-target");
      if (action?.endsWith("UpdateItem")) updates++;
      return json({
        Item: {
          value: { S: "9007199254740991" },
          revision: { S: "r" },
          counter: { N: "9007199254740991" },
        },
      });
    });
    await expect(kv.increment("k", 1)).rejects.toBeInstanceOf(
      InvalidCounterError,
    );
    expect(updates).toBe(0);
  });
  it("never repeats an increment after an ambiguous committed update", async () => {
    for (const overwritten of [false, true]) {
      let reads = 0,
        updates = 0,
        revision = "";
      const kv = make(async (_url, init) => {
        const action = new Headers(init?.headers).get("x-amz-target") ?? "";
        if (action.endsWith("GetItem")) {
          reads++;
          return json({
            Item: {
              value: { S: "5" },
              revision: {
                S: reads === 1 ? "before" : overwritten ? "another" : revision,
              },
              counter: { N: reads === 1 ? "5" : "6" },
              ...(reads === 1 ? {} : { counterActive: { BOOL: true } }),
            },
          });
        }
        updates++;
        revision = JSON.parse(String(init?.body)).ExpressionAttributeValues[
          ":revision"
        ].S;
        return updates === 1
          ? json({ __type: "InternalServerError" }, 503)
          : json({ __type: "ConditionalCheckFailedException" }, 400);
      });
      if (overwritten)
        await expect(kv.increment("k", 1)).rejects.toBeInstanceOf(
          KVUnavailableError,
        );
      else expect(await kv.increment("k", 1)).toBe(6);
      expect(updates).toBe(2);
      expect(reads).toBe(2);
    }
  });
  it("redacts credential-like provider codes", async () => {
    const error = await make(async () =>
      json({ __type: "fixture", message: "sensitive-secret" }, 400),
    )
      .get("k")
      .catch((e: unknown) => e);
    expect(String(error)).not.toContain("sensitive-secret");
    expect(String(error)).not.toContain("fixture");
    expect(error).toMatchObject({ providerCode: undefined });
  });
  it("requires delivered table and region", () => {
    expect(() =>
      create({ config: {}, bindings: {}, dependencies: {} }),
    ).toThrow("table");
    expect(() =>
      create({
        config: {},
        bindings: { ERRTRAQ_KV_TABLE: "t" },
        dependencies: {},
        environment: {},
      }),
    ).toThrow("region");
  });
});
