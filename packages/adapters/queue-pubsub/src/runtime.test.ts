import { describe, expect, it, vi } from "vitest";
import { PUBSUB_MAX_BYTES } from "./constants.js";
import { FakePubsub, PROJECT, TOKEN, verifyToken } from "./fake.testing.js";
import {
  orderingKeyFor,
  type PubsubOptions,
  type PubsubPushRequest,
  PubsubQueue,
} from "./runtime.js";

const sub = `projects/${PROJECT}/subscriptions/shared`;
const decode = (data: string) =>
  JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
    ),
  );
const base = (overrides: Partial<PubsubOptions> = {}): PubsubOptions => ({
  projectId: PROJECT,
  region: "us-central1",
  bindings: {
    SHARED: `projects/${PROJECT}/topics/shared`,
    RECORD: `projects/${PROJECT}/topics/record`,
  },
  topics: {
    ingest: { physical: "shared", producerBinding: "SHARED" },
    record: {
      physical: "record",
      producerBinding: "RECORD",
      grouping: "per-key-serial",
    },
  },
  consumers: [{ physical: "shared", eventSource: sub, topics: ["ingest"] }],
  accessToken: async () => "access-token",
  verifyPush: verifyToken,
  sleep: async () => {},
  random: () => 0.5,
  ...overrides,
});
const envelope = (message: Record<string, unknown>, extra = {}) => ({
  message: {
    data: btoa(JSON.stringify({ key: "k", body: { a: 1 } })),
    attributes: { "errtraq-topic": "ingest" },
    messageId: "m1",
    publishTime: "2026-11-26T00:00:00Z",
    ...message,
  },
  subscription: sub,
  ...extra,
});
const request = (
  body: unknown,
  overrides: Partial<PubsubPushRequest> = {},
): PubsubPushRequest => ({
  method: "POST",
  headers: { authorization: `Bearer ${TOKEN}` },
  body: typeof body === "string" ? body : JSON.stringify(body),
  ...overrides,
});
const ack = async (batch: { id: string }[]) =>
  batch.map((d) => ({ deliveryId: d.id, action: "ack" as const }));

describe("producer", () => {
  it("publishes base64 JSON data with attributes, the token and no ordering key", async () => {
    const fake = new FakePubsub();
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    await q.producer.send("ingest", [{ key: "e1", body: { v: 1 } }]);
    const [call] = fake.calls;
    expect(call?.url).toBe(
      `https://pubsub.googleapis.com/v1/projects/${PROJECT}/topics/shared:publish`,
    );
    expect(call?.authorization).toBe("Bearer access-token");
    expect(call?.messages).toHaveLength(1);
    const message = call?.messages[0];
    expect(message?.attributes).toEqual({
      "errtraq-topic": "ingest",
      "errtraq-key": "e1",
    });
    expect(message).not.toHaveProperty("orderingKey");
    expect(decode(message?.data ?? "")).toEqual({ key: "e1", body: { v: 1 } });
  });
  it("uses the regional endpoint and an ordering key for grouped topics", async () => {
    const fake = new FakePubsub();
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    await q.producer.send("record", [
      { key: "e1", groupKey: "issue-1", body: 1 },
    ]);
    expect(fake.calls[0]?.url).toBe(
      `https://us-central1-pubsub.googleapis.com/v1/projects/${PROJECT}/topics/record:publish`,
    );
    expect(fake.calls[0]?.messages[0]?.orderingKey).toBe("issue-1");
    expect(decode(fake.calls[0]?.messages[0]?.data ?? "").groupKey).toBe(
      "issue-1",
    );
  });
  it("hashes ordering keys longer than 1024 bytes and keeps the group key in the data", async () => {
    const fake = new FakePubsub();
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    const long = "g".repeat(2000);
    await q.producer.send("record", [{ key: "e", groupKey: long, body: 1 }]);
    const key = fake.calls[0]?.messages[0]?.orderingKey ?? "";
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(key).toBe(await orderingKeyFor(long));
    expect(decode(fake.calls[0]?.messages[0]?.data ?? "").groupKey).toBe(long);
  });
  it("requires a group key on grouped topics and rejects delay", async () => {
    const fake = new FakePubsub();
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    await expect(
      q.producer.send("record", [{ key: "e", body: 1 }]),
    ).rejects.toThrow(/group key/);
    await expect(
      q.producer.send("ingest", [{ key: "e", body: 1 }], { delaySec: 5 }),
    ).rejects.toThrow(/delay/);
    expect(fake.calls).toHaveLength(0);
  });
  it("splits requests at 1000 messages, in order", async () => {
    const fake = new FakePubsub();
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    await q.producer.send(
      "ingest",
      Array.from({ length: 2500 }, (_, i) => ({ key: `k${i}`, body: i })),
    );
    expect(fake.calls.map((c) => c.messages.length)).toEqual([1000, 1000, 500]);
    expect(fake.calls[1]?.messages[0]?.attributes["errtraq-key"]).toBe("k1000");
  });
  it("splits requests below the 10 MB request limit", async () => {
    const fake = new FakePubsub();
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    const body = "x".repeat(3_000_000);
    await q.producer.send("ingest", [
      { key: "a", body },
      { key: "b", body },
      { key: "c", body },
    ]);
    expect(fake.calls.map((c) => c.messages.length)).toEqual([2, 1]);
    for (const call of fake.calls)
      expect(JSON.stringify(call).length).toBeLessThan(10_000_000);
  });
  it("rejects a message above maxBytes before publishing anything", async () => {
    const fake = new FakePubsub();
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    expect(q.capabilities.maxBytes).toBe(PUBSUB_MAX_BYTES);
    await expect(
      q.producer.send("ingest", [
        { key: "ok", body: 1 },
        { key: "big", body: "x".repeat(PUBSUB_MAX_BYTES) },
      ]),
    ).rejects.toThrow(/maxBytes/);
    expect(fake.calls).toHaveLength(0);
  });
  it("retries transient publish errors and then succeeds", async () => {
    const fake = new FakePubsub();
    fake.failures.push(503, 429);
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    await q.producer.send("ingest", [{ key: "e", body: 1 }]);
    expect(fake.calls).toHaveLength(3);
  });
  it("does not retry permanent errors and never leaks the token", async () => {
    const fake = new FakePubsub();
    fake.failures.push(403);
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    const error = await q.producer
      .send("ingest", [{ key: "e", body: 1 }])
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("HTTP 403");
    expect(String(error)).not.toContain("access-token");
    expect(fake.calls).toHaveLength(1);
  });
  it("gives up after repeated transient errors without publishing later batches", async () => {
    const fake = new FakePubsub();
    fake.failures.push(503, 503, 503, 503, 503);
    const q = new PubsubQueue(base({ fetch: fake.fetch }));
    await expect(
      q.producer.send(
        "ingest",
        Array.from({ length: 1500 }, (_, i) => ({ key: `k${i}`, body: i })),
      ),
    ).rejects.toThrow(/503/);
    expect(fake.calls).toHaveLength(5);
    expect(fake.calls.every((c) => c.messages.length === 1000)).toBe(true);
  });
  it("retries network errors", async () => {
    const fake = new FakePubsub();
    let first = true;
    const q = new PubsubQueue(
      base({
        fetch: async (input, init) => {
          if (first) {
            first = false;
            throw new TypeError("network");
          }
          return fake.fetch(input, init);
        },
      }),
    );
    await q.producer.send("ingest", [{ key: "e", body: 1 }]);
    expect(fake.calls).toHaveLength(1);
  });
  it("requires a token source unless an endpoint override is set, and omits auth for it", async () => {
    expect(() => new PubsubQueue(base({ accessToken: undefined }))).toThrow(
      /accessToken/,
    );
    const fake = new FakePubsub();
    const q = new PubsubQueue(
      base({
        accessToken: undefined,
        endpoint: "http://127.0.0.1:8085",
        fetch: fake.fetch,
      }),
    );
    await q.producer.send("record", [{ key: "e", groupKey: "g", body: 1 }]);
    expect(fake.calls[0]?.url).toBe(
      `http://127.0.0.1:8085/v1/projects/${PROJECT}/topics/record:publish`,
    );
    expect(fake.calls[0]?.authorization).toBeUndefined();
  });
  it("rejects a missing or malformed topic binding", async () => {
    const q = new PubsubQueue(base({ bindings: { SHARED: "not-a-topic" } }));
    await expect(
      q.producer.send("ingest", [{ key: "e", body: 1 }]),
    ).rejects.toThrow(/binding/);
    await expect(
      q.producer.send("nope", [{ key: "e", body: 1 }]),
    ).rejects.toThrow(/Unknown/);
  });
});

describe("capabilities", () => {
  it("states the truth about this transport", () => {
    const q = new PubsubQueue(base());
    expect(q.capabilities).toMatchObject({
      delivery: "push",
      delay: false,
      dlq: true,
      grouping: "per-key-serial",
      physicalQueues: {
        shared: { grouping: "none", delay: false },
        record: { grouping: "per-key-serial", delay: false },
      },
    });
    expect((q as { pull?: unknown }).pull).toBeUndefined();
  });
});

describe("push source", () => {
  const handle = (
    overrides: Partial<PubsubOptions>,
    req: PubsubPushRequest,
    handler: Parameters<PubsubQueue["push"]["handle"]>[1] = ack,
  ) => new PubsubQueue(base(overrides)).push.handle(req, handler);
  it("decodes the documented envelope into one delivery and acknowledges with 204", async () => {
    const seen: unknown[] = [];
    const result = await handle(
      {},
      request(envelope({}, { deliveryAttempt: 3 })),
      async (batch) => {
        seen.push(...batch);
        return ack(batch);
      },
    );
    expect(result.status).toBe(204);
    expect(seen).toEqual([
      {
        id: "m1",
        topic: "ingest",
        message: { key: "k", body: { a: 1 } },
        attempt: 3,
      },
    ]);
  });
  it("defaults the attempt to 1 without a dead-letter policy and accepts a parsed body", async () => {
    const seen: number[] = [];
    await handle(
      {},
      request(JSON.parse(JSON.stringify(envelope({}))), { body: envelope({}) }),
      async (b) => {
        seen.push(...b.map((d) => d.attempt));
        return ack(b);
      },
    );
    expect(seen).toEqual([1]);
  });
  it("maps retry, a missing result and a throwing handler to nacks", async () => {
    const warn = vi.fn();
    const retry = await handle(
      { logger: { warn, error: vi.fn() } },
      request(envelope({})),
      async (b) => [
        { deliveryId: b[0]?.id ?? "", action: "retry", delaySec: 30 },
      ],
    );
    expect(retry.status).toBe(503);
    expect(warn).toHaveBeenCalled();
    expect(
      (await handle({}, request(envelope({})), async () => [])).status,
    ).toBe(503);
    expect(
      (
        await handle({}, request(envelope({})), async () => {
          throw new Error("boom");
        })
      ).status,
    ).toBe(500);
  });
  it("rejects non-POST requests", async () => {
    expect(
      (await handle({}, request(envelope({}), { method: "GET" }))).status,
    ).toBe(405);
  });
  it.each([
    ["not json", "{"],
    ["no message", { subscription: sub }],
    ["no data", envelope({ data: undefined })],
    ["no message id", envelope({ messageId: "" })],
    ["bad base64", envelope({ data: "***" })],
    ["data not JSON", envelope({ data: btoa("nope") })],
    ["data without body", envelope({ data: btoa('{"key":"k"}') })],
    ["unknown topic", envelope({ attributes: { "errtraq-topic": "other" } })],
    ["no topic", envelope({ attributes: {} })],
    [
      "unknown subscription",
      { ...envelope({}), subscription: "projects/p/subscriptions/x" },
    ],
    ["bad attempt", envelope({}, { deliveryAttempt: 0 })],
  ])(
    "nacks with 400 and never runs the handler for %s",
    async (_name, body) => {
      const handler = vi.fn(ack);
      expect((await handle({}, request(body), handler)).status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
    },
  );
  it("requires a group key and a consistent ordering key on grouped subscriptions", async () => {
    const options = {
      consumers: [{ physical: "record", eventSource: sub, topics: ["record"] }],
    };
    const data = btoa(JSON.stringify({ key: "k", body: 1, groupKey: "g1" }));
    const attributes = { "errtraq-topic": "record" };
    const ok = await handle(
      options,
      request(envelope({ data, attributes, orderingKey: "g1" })),
    );
    expect(ok.status).toBe(204);
    for (const orderingKey of ["other"])
      expect(
        (
          await handle(
            options,
            request(envelope({ data, attributes, orderingKey })),
          )
        ).status,
      ).toBe(400);
    // The emulator omits orderingKey; the group key in the data still decides.
    expect(
      (await handle(options, request(envelope({ data, attributes })))).status,
    ).toBe(204);
    const noGroup = btoa(JSON.stringify({ key: "k", body: 1 }));
    expect(
      (
        await handle(
          options,
          request(envelope({ data: noGroup, attributes, orderingKey: "g1" })),
        )
      ).status,
    ).toBe(400);
    const long = "g".repeat(1500);
    const longData = btoa(
      JSON.stringify({ key: "k", body: 1, groupKey: long }),
    );
    expect(
      (
        await handle(
          options,
          request(
            envelope({
              data: longData,
              attributes,
              orderingKey: await orderingKeyFor(long),
            }),
          ),
        )
      ).status,
    ).toBe(204);
  });
  describe("authentication", () => {
    it("rejects pushes the verifier denies, without running the handler", async () => {
      const handler = vi.fn(ack);
      const denied = request(envelope({}), {
        headers: { authorization: "Bearer other" },
      });
      expect((await handle({}, denied, handler)).status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });
    it("fails closed and nacks when the verifier throws", async () => {
      const handler = vi.fn(ack);
      const result = await handle(
        {
          verifyPush: async () => {
            throw new Error("jwks unavailable");
          },
          logger: { warn: vi.fn(), error: vi.fn() },
        },
        request(envelope({})),
        handler,
      );
      expect(result.status).toBe(503);
      expect(handler).not.toHaveBeenCalled();
    });
    it("verifies even when unauthenticated pushes are allowed and a verifier exists", async () => {
      const denied = request(envelope({}), { headers: {} });
      expect(
        (await handle({ allowUnauthenticatedPush: true }, denied)).status,
      ).toBe(401);
    });
    it("refuses to construct consumers with neither a verifier nor the explicit test-only opt-out", () => {
      expect(() => new PubsubQueue(base({ verifyPush: undefined }))).toThrow(
        /verifyPush/,
      );
    });
    it("accepts pushes without a verifier only through the explicit opt-out", async () => {
      const result = await handle(
        { verifyPush: undefined, allowUnauthenticatedPush: true },
        request(envelope({}), { headers: {} }),
      );
      expect(result.status).toBe(204);
    });
  });
});
