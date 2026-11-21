import { readFile } from "node:fs/promises";
import {
  type BatchHandler,
  bootstrapProject,
  ConsumerService,
  type Delivery,
  type EventId,
  generateApiToken,
  generateEventId,
  generatePublicKey,
  groupEvent,
  hashApiToken,
  IngestService,
  type Logger,
  type Message,
  normalizeEvent,
  parseEnvelope,
  parseEventPayload,
  recoverStagedEnvelopes,
  WebCryptoIdGen,
} from "@errtraq/core";
import { createIngestApp } from "@errtraq/http";
import { describe, expect, it, vi } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryBlobStore, MemoryKV, MemoryQueue } from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

const body = (
  id: string,
  message: string,
  extra: Record<string, unknown> = {},
) =>
  `${JSON.stringify({ event_id: id })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: id, message, ...extra })}\n`;
const id = (value: number) => value.toString(16).padStart(32, "0");
async function setup(
  options: {
    rateLimit?: number | null;
    maxBytes?: number;
    overflowBytes?: number;
  } = {},
) {
  const store = new MemoryActiveStore();
  const clock = new FakeClock();
  const kv = new MemoryKV(clock);
  const blobs = new MemoryBlobStore();
  const queue = new MemoryQueue(clock);
  const ids = new DeterministicIdGen();
  const project = await bootstrapProject({
    store,
    kv,
    ids,
    orgSlug: "org",
    projectSlug: "project",
  });
  const sent: Message[] = [];
  const producer = {
    send: async (
      topic: string,
      messages: Message[],
      opts?: { delaySec?: number },
    ) => {
      sent.push(...structuredClone(messages));
      await queue.producer.send(topic, messages, opts);
    },
  };
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const consumer = new ConsumerService({
    store,
    blobs,
    kv,
    logger,
    overflowBytes: options.overflowBytes,
    maxEnvelopeBytes: options.maxBytes,
  });
  const service = new IngestService({
    store,
    blobs,
    queue: producer,
    kv,
    clock,
    logger,
    rateLimit: options.rateLimit,
    maxBytes: options.maxBytes,
  });
  const app = createIngestApp(service);
  const send = (payload: string, headers: Record<string, string> = {}) =>
    app.request(
      `/api/${project.project.id}/envelope/?sentry_key=${project.key.publicKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          ...headers,
        },
        body: payload,
      },
    );
  return {
    store,
    clock,
    kv,
    blobs,
    queue,
    project,
    sent,
    logger,
    consumer,
    service,
    app,
    send,
  };
}
async function withConsumer(
  queue: MemoryQueue,
  handler: BatchHandler,
  run: () => Promise<void>,
) {
  const signal = new AbortController();
  const running = queue.pull.run(handler, signal.signal);
  try {
    await run();
  } finally {
    signal.abort();
    await running;
  }
}

describe("in-process ingest pipeline", () => {
  it("posts envelopes, groups events and handles duplicates and redelivery", async () => {
    const c = await setup();
    await withConsumer(c.queue, c.consumer.handle, async () => {
      for (const payload of [
        body(id(1), "same"),
        body(id(2), "same"),
        body(id(3), "different"),
        body(id(1), "same"),
      ]) {
        const r = await c.send(payload);
        expect(r.status).toBe(200);
      }
      await vi.waitFor(async () => {
        const page = await c.store.issues.list({
          projectId: c.project.project.id,
          sort: "count",
        });
        expect(page.items).toHaveLength(2);
        expect(page.items.map((x) => x.count).sort()).toEqual([1, 2]);
      });
      const event = await c.store.events.get(
        c.project.project.id,
        id(1) as never,
      );
      expect(event?.payload.message).toBe("same");
      const original = c.sent[0];
      if (!original) throw new Error("Missing claim");
      const replay: Delivery = {
        id: "replay",
        topic: "ingest",
        attempt: 5,
        message: original,
      };
      c.clock.advance(8 * 24 * 3600 * 1000);
      expect(await c.consumer.handle([replay])).toEqual([
        { deliveryId: "replay", action: "ack" },
      ]);
      expect(
        (
          await c.store.issues.list({
            projectId: c.project.project.id,
            sort: "count",
          })
        ).items
          .map((x) => x.count)
          .sort(),
      ).toEqual([1, 2]);
    });
  });
  it("authenticates, applies rate limits and returns CORS headers", async () => {
    const c = await setup({ rateLimit: 1 });
    const unauthorized = await c.app.request(
      `/api/${c.project.project.id}/envelope/`,
      { method: "POST", body: body(id(1), "a") },
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("access-control-allow-origin")).toBe("*");
    const denied = await c.app.request(
      `/api/${c.project.project.id}/envelope/?sentry_key=bad`,
      { method: "POST", body: body(id(1), "a") },
    );
    expect(denied.status).toBe(403);
    expect((await c.send(body(id(1), "a"))).status).toBe(200);
    const limited = await c.send(body(id(2), "b"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(limited.headers.get("x-sentry-rate-limits")).toBe("60::project");
    const preflight = await c.app.request(
      `/api/${c.project.project.id}/envelope/`,
      { method: "OPTIONS" },
    );
    expect(preflight.status).toBe(204);
    c.clock.advance(60000);
    expect((await c.send(body(id(2), "b"))).status).toBe(200);
  });
  it("accepts legacy store, header auth and gzip/deflate", async () => {
    const c = await setup();
    const url = `/api/${c.project.project.id}/store/`;
    const legacy = JSON.stringify({ event_id: id(4), message: "legacy" });
    const first = await c.app.request(url, {
      method: "POST",
      headers: {
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${c.project.key.publicKey}`,
      },
      body: legacy,
    });
    expect(first.status).toBe(200);
    for (const encoding of ["gzip", "deflate"] as const) {
      const source = new ReadableStream<BufferSource>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body(id(5), encoding)));
          controller.close();
        },
      });
      const compressed = await new Response(
        source.pipeThrough(new CompressionStream(encoding)),
      ).arrayBuffer();
      const r = await c.app.request(
        `/api/${c.project.project.id}/envelope/?sentry_key=${c.project.key.publicKey}`,
        {
          method: "POST",
          headers: { "Content-Encoding": encoding },
          body: compressed,
        },
      );
      expect(r.status).toBe(200);
    }
    const unsupported = await c.send(body(id(5), "x"), {
      "Content-Encoding": "unknown",
    });
    expect(unsupported.status).toBe(415);
  });
  it("enforces payload limits and rejects malformed input", async () => {
    const c = await setup({ maxBytes: 128 });
    expect((await c.send("x".repeat(129))).status).toBe(413);
    const malformed = await c.send("not-json");
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("x-sentry-error")).toBeTruthy();
  });
  it("stores large payloads by reference and skips unsupported items", async () => {
    const c = await setup({ overflowBytes: 10 });
    const payload = `${body(id(6), "large")}{"type":"transaction"}\n{}\n`;
    expect((await c.send(payload)).status).toBe(200);
    await withConsumer(c.queue, c.consumer.handle, async () => {
      await vi.waitFor(async () => {
        const saved = await c.store.events.get(
          c.project.project.id,
          id(6) as never,
        );
        expect(saved?.payloadBlobKey).toBeTruthy();
      });
    });
    const saved = await c.store.events.get(
      c.project.project.id,
      id(6) as never,
    );
    expect(saved?.payload).toEqual({});
    expect(
      saved?.payloadBlobKey && (await c.blobs.get(saved.payloadBlobKey)),
    ).toBeTruthy();
    expect(c.logger.info).toHaveBeenCalledWith(
      "Dropped unsupported envelope items",
      { count: 1 },
    );
  });
  it("retries transient failures and acknowledges malformed poison", async () => {
    const c = await setup();
    const response = await c.send(body(id(7), "retry"));
    expect(response.status).toBe(200);
    const claim = c.sent[0];
    if (!claim) throw new Error("Missing claim");
    const delivery: Delivery = {
      id: "d",
      topic: "ingest",
      attempt: 1,
      message: claim,
    };
    const original = c.store.recordEvent.bind(c.store);
    const spy = vi
      .spyOn(c.store, "recordEvent")
      .mockRejectedValueOnce(new Error("temporary"));
    expect(await c.consumer.handle([delivery])).toEqual([
      { deliveryId: "d", action: "retry" },
    ]);
    spy.mockImplementation(original);
    expect(await c.consumer.handle([delivery])).toEqual([
      { deliveryId: "d", action: "ack" },
    ]);
    const poisoned = {
      ...delivery,
      id: "bad",
      message: {
        ...claim,
        body: {
          projectId: c.project.project.id,
          blobKey: "invalid",
          receivedAt: c.clock.now(),
        },
      },
    };
    await c.blobs.put("invalid", new TextEncoder().encode("invalid"));
    expect(await c.consumer.handle([poisoned])).toEqual([
      { deliveryId: "bad", action: "ack" },
    ]);
    expect(c.logger.error).toHaveBeenCalled();
  });
  it("redacts credentials from failed consumer delivery logs", async () => {
    const c = await setup();
    await c.send(body(id(1), "test"));
    const message = c.sent[0];
    if (!message) throw new Error("missing claim");
    vi.spyOn(c.blobs, "get").mockRejectedValue(
      new Error(
        "Authorization: Bearer tok123 password=secret123 https://user:pass@example.test/path",
      ),
    );
    expect(
      await c.consumer.handle([
        { id: "d", topic: "ingest", attempt: 1, message },
      ]),
    ).toEqual([{ deliveryId: "d", action: "retry" }]);
    const logged = JSON.stringify(vi.mocked(c.logger.error).mock.calls);
    for (const secret of ["tok123", "secret123", "user:pass"])
      expect(logged).not.toContain(secret);
    expect(logged).toContain("[redacted]");
  });
  it("bootstraps numeric projects idempotently", async () => {
    const c = await setup();
    const again = await bootstrapProject({
      store: c.store,
      kv: c.kv,
      ids: new DeterministicIdGen(),
      orgSlug: "org",
      projectSlug: "project",
    });
    expect(again).toEqual(c.project);
    expect(c.project.project.id).toMatch(/^\d+$/);
  });
  it("does not acknowledge messages for other topics", async () => {
    const c = await setup();
    const result = await c.consumer.handle([
      {
        id: "other",
        topic: "archive.project",
        attempt: 1,
        message: { key: "archive", body: {} },
      },
    ]);
    expect(result).toEqual([{ deliveryId: "other", action: "retry" }]);
  });
  it("rejects inconsistent envelope IDs and unsupported brotli", async () => {
    const c = await setup();
    const mismatch = `${JSON.stringify({ event_id: id(1) })}\n{"type":"event"}\n${JSON.stringify({ event_id: id(2), message: "x" })}\n`;
    expect((await c.send(mismatch)).status).toBe(200);
    try {
      new DecompressionStream("br" as CompressionFormat);
    } catch {
      expect((await c.send("abc", { "Content-Encoding": "br" })).status).toBe(
        415,
      );
    }
  });
  it("handles a legacy body near the configured size limit", async () => {
    const payload = JSON.stringify({
      event_id: id(8),
      message: "x".repeat(30),
    });
    const c = await setup({
      maxBytes: new TextEncoder().encode(payload).length,
    });
    const result = await c.app.request(
      `/api/${c.project.project.id}/store/?sentry_key=${c.project.key.publicKey}`,
      { method: "POST", body: payload },
    );
    expect(result.status).toBe(200);
    await withConsumer(c.queue, c.consumer.handle, async () => {
      await vi.waitFor(async () =>
        expect(
          await c.store.events.get(c.project.project.id, id(8) as never),
        ).not.toBeNull(),
      );
    });
  });
  it("returns retryable failure and removes staged data on publication failure", async () => {
    const c = await setup();
    vi.spyOn(c.queue.producer, "send").mockRejectedValueOnce(
      new Error("failure"),
    );
    const response = await c.send(body(id(9), "failure"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(
      (await c.blobs.list(`envelopes/${c.project.project.id}/`)).items,
    ).toEqual([]);
  });
  it("allocates around existing project IDs after the KV counter resets", async () => {
    const c = await setup();
    const reset = new MemoryKV(c.clock);
    const second = await bootstrapProject({
      store: c.store,
      kv: reset,
      ids: new DeterministicIdGen(),
      orgSlug: "org",
      projectSlug: "second",
    });
    expect(second.project.id).toBe("2");
  });
  it("groups exception events by in-app frame and exception type", async () => {
    const c = await setup();
    const exception = (type: string, filename: string) => ({
      exception: {
        values: [
          {
            type,
            value: "oops",
            stacktrace: { frames: [{ filename, in_app: true }] },
          },
        ],
      },
    });
    await withConsumer(c.queue, c.consumer.handle, async () => {
      for (const payload of [
        body(id(11), "unused", exception("TypeError", "main.js")),
        body(id(12), "unused", exception("TypeError", "main.js")),
        body(id(13), "unused", exception("RangeError", "main.js")),
      ])
        expect((await c.send(payload)).status).toBe(200);
      await vi.waitFor(async () => {
        const issues = (
          await c.store.issues.list({
            projectId: c.project.project.id,
            sort: "count",
          })
        ).items;
        expect(issues).toHaveLength(2);
        expect(issues.map((issue) => issue.count).sort()).toEqual([1, 2]);
        expect(issues.map((issue) => issue.type).sort()).toEqual([
          "RangeError",
          "TypeError",
        ]);
      });
    });
  });
  it("does not stage or rate-limit unsupported-only envelopes", async () => {
    const c = await setup({ rateLimit: 1 });
    const payload = `${JSON.stringify({ event_id: id(14) })}\n{"type":"transaction"}\n{}\n`;
    expect((await c.send(payload)).status).toBe(200);
    expect(c.sent).toHaveLength(0);
    expect(c.logger.info).toHaveBeenCalledWith(
      "Dropped unsupported envelope items",
      { types: { transaction: 1 } },
    );
    expect((await c.blobs.list("envelopes/")).items).toEqual([]);
    expect((await c.send(body(id(14), "event"))).status).toBe(200);
  });
  it("bounds decompressed input and reports corrupt compression", async () => {
    const c = await setup({ maxBytes: 128 });
    const url = `/api/${c.project.project.id}/envelope/?sentry_key=${c.project.key.publicKey}`;
    const source = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(5000)));
        controller.close();
      },
    });
    const compressed = await new Response(
      source.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    expect(compressed.byteLength).toBeLessThan(128);
    expect(
      (
        await c.app.request(url, {
          method: "POST",
          headers: { "Content-Encoding": "gzip" },
          body: compressed,
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await c.app.request(url, {
          method: "POST",
          headers: { "Content-Encoding": "gzip" },
          body: "invalid",
        })
      ).status,
    ).toBe(400);
  });
  it("keeps the first overflow payload and removes duplicate overflow blobs", async () => {
    const c = await setup({ overflowBytes: 1 });
    await withConsumer(c.queue, c.consumer.handle, async () => {
      expect((await c.send(body(id(15), "first"))).status).toBe(200);
      expect((await c.send(body(id(15), "changed"))).status).toBe(200);
      await vi.waitFor(async () => {
        expect(
          (await c.blobs.list(`envelopes/${c.project.project.id}/`)).items,
        ).toHaveLength(0);
        expect(
          (
            await c.store.issues.list({
              projectId: c.project.project.id,
              sort: "count",
            })
          ).items[0]?.count,
        ).toBe(1);
      });
    });
    const stored = await c.store.events.get(
      c.project.project.id,
      id(15) as never,
    );
    if (!stored?.payloadBlobKey) throw new Error("Missing overflow reference");
    const stream = await c.blobs.get(stored.payloadBlobKey);
    if (!stream) throw new Error("Missing overflow payload");
    expect(JSON.parse(await new Response(stream).text()).message).toBe("first");
    expect(
      (await c.blobs.list(`payloads/${c.project.project.id}/`)).items,
    ).toEqual([stored.payloadBlobKey]);
  });
  it("rejects revoked keys and keys from another project", async () => {
    const c = await setup();
    const other = await bootstrapProject({
      store: c.store,
      kv: c.kv,
      ids: new DeterministicIdGen(),
      orgSlug: "org",
      projectSlug: "other",
    });
    expect(
      (
        await c.app.request(
          `/api/${other.project.id}/envelope/?sentry_key=${c.project.key.publicKey}`,
          { method: "POST", body: body(id(16), "x") },
        )
      ).status,
    ).toBe(403);
    await c.store.projects.putKey({
      ...c.project.key,
      revokedAt: c.clock.now(),
    });
    expect((await c.send(body(id(16), "x"))).status).toBe(403);
  });
  it("runs captured real SDK envelopes through parser, normalizer and pipeline", async () => {
    const c = await setup();
    const fixtures = [
      "sdk-2.envelope",
      "sdk-3.envelope",
      "sdk-4.envelope",
      "sdk-5.envelope",
      "sdk-6.envelope",
      "mixed.envelope",
      "additional-0.envelope",
    ];
    for (const name of fixtures) {
      const bytes = await readFile(
        new URL(`../fixtures/sentry/${name}`, import.meta.url),
      );
      const parsed = parseEnvelope(bytes);
      for (const item of parsed.items.filter(
        (item) => item.headers.type === "event",
      )) {
        const payload = parseEventPayload(item.payload);
        expect(
          (
            await normalizeEvent(
              c.project.project.id,
              id(100) as EventId,
              c.clock.now(),
              payload,
            )
          ).event.payload,
        ).toEqual(payload);
      }
      const response = await c.app.request(
        `/api/${c.project.project.id}/envelope?sentry_key=${c.project.key.publicKey}`,
        { method: "POST", body: bytes },
      );
      expect(response.status, name).toBe(200);
    }
    await withConsumer(c.queue, c.consumer.handle, async () => {
      await vi.waitFor(async () =>
        expect(
          (
            await c.store.issues.list({
              projectId: c.project.project.id,
              sort: "count",
            })
          ).items.length,
        ).toBeGreaterThanOrEqual(4),
      );
    });
    const compressed = await readFile(
      new URL("../fixtures/sentry/large.envelope.gz", import.meta.url),
    );
    expect(compressed.length).toBeGreaterThan(32768);
    const before = c.sent.length;
    expect(
      (
        await c.app.request(
          `/api/${c.project.project.id}/envelope?sentry_key=${c.project.key.publicKey}`,
          {
            method: "POST",
            headers: { "Content-Encoding": "gzip" },
            body: compressed,
          },
        )
      ).status,
    ).toBe(200);
    expect(c.sent).toHaveLength(before + 1);
    await withConsumer(c.queue, c.consumer.handle, async () => {
      await vi.waitFor(async () =>
        expect(
          (await c.blobs.list(`envelopes/${c.project.project.id}/`)).items,
        ).toHaveLength(0),
      );
    });
  });
  it("accepts a header DSN, without slash, and repairs distinct ids for multiple events", async () => {
    const c = await setup();
    const h = JSON.stringify({
      dsn: `https://${c.project.key.publicKey}@example.com/${c.project.project.id}`,
    });
    const payload = `${h}\n{"type":"event"}\n{"message":"one"}\n{"type":"event"}\n{"message":"two"}\n`;
    expect(
      (
        await c.app.request(`/api/${c.project.project.id}/envelope`, {
          method: "POST",
          body: payload,
        })
      ).status,
    ).toBe(200);
    await withConsumer(c.queue, c.consumer.handle, async () => {
      await vi.waitFor(async () =>
        expect(
          (
            await c.store.issues.list({
              projectId: c.project.project.id,
              sort: "count",
            })
          ).items,
        ).toHaveLength(2),
      );
    });
    expect(
      (
        await c.app.request(
          `/api/${c.project.project.id}/store?sentry_key=${c.project.key.publicKey}`,
          { method: "POST", body: '{"message":"legacy"}' },
        )
      ).status,
    ).toBe(200);
  });
  it("checks known auth and declared size before reading the body", async () => {
    const c = await setup();
    const read = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        read();
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const request = new Request(
      `http://localhost/api/${c.project.project.id}/envelope?sentry_key=bad`,
      { method: "POST", body: stream, duplex: "half" } as RequestInit,
    );
    const result = await c.app.fetch(request);
    expect(result.status).toBe(403);
    expect(
      (
        await c.app.request(
          `/api/${c.project.project.id}/envelope?sentry_key=${c.project.key.publicKey}`,
          {
            method: "POST",
            headers: { "Content-Length": "99999999" },
            body: "x",
          },
        )
      ).status,
    ).toBe(413);
  });
  it("uses a bounded missing-blob retry and exposes erasure suppression", async () => {
    const c = await setup();
    await c.send(body(id(22), "suppressed"));
    const message = c.sent[0];
    if (!message) throw new Error("Missing claim");
    const delivery = { id: "x", topic: "ingest", attempt: 1, message };
    const consumer = new ConsumerService({
      store: c.store,
      blobs: c.blobs,
      kv: c.kv,
      logger: c.logger,
      shouldSuppress: () => true,
    });
    expect((await consumer.handle([delivery]))[0]?.action).toBe("ack");
    expect(
      await c.store.events.get(c.project.project.id, id(22) as EventId),
    ).toBeNull();
    expect((await consumer.handle([delivery]))[0]?.action).toBe("retry");
    expect(
      (await consumer.handle([{ ...delivery, attempt: 5 }]))[0]?.action,
    ).toBe("ack");
  });
  it("generates secure-format keys, event IDs and hashed tokens", async () => {
    const key = generatePublicKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(generatePublicKey()).not.toBe(key);
    expect(generateEventId()).toMatch(/^[0-9a-f]{32}$/);
    expect(new WebCryptoIdGen().next()).toMatch(/^[0-9a-f-]{36}$/);
    const token = generateApiToken();
    expect(token).toMatch(/^errtraq_[0-9a-f]{64}$/);
    expect(await hashApiToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashApiToken(token)).not.toBe(token);
  });
  it("bootstraps a single organization, project and key under concurrency", async () => {
    const store = new MemoryActiveStore();
    const clock = new FakeClock();
    const kv = new MemoryKV(clock);
    const options = {
      store,
      kv,
      ids: new WebCryptoIdGen(),
      orgSlug: "race",
      projectSlug: "race",
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => bootstrapProject(options)),
    );
    expect(new Set(results.map((r) => r.org.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.project.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.key.publicKey)).size).toBe(1);
    const first = results[0];
    if (!first) throw new Error("Missing bootstrap result");
    expect(await store.projects.listKeys(first.project.id)).toHaveLength(1);
  });
  it("reuses one overflow key across failures and does not leave completion markers", async () => {
    const c = await setup({ overflowBytes: 1 });
    await c.send(body(id(25), "retry overflow"));
    const message = c.sent[0];
    if (!message) throw new Error("Missing claim");
    const delivery = { id: "overflow", topic: "ingest", attempt: 1, message };
    const original = c.store.recordEvent.bind(c.store);
    vi.spyOn(c.store, "recordEvent")
      .mockRejectedValueOnce(new Error("failure 1"))
      .mockRejectedValueOnce(new Error("failure 2"))
      .mockImplementation(original);
    expect((await c.consumer.handle([delivery]))[0]?.action).toBe("retry");
    expect((await c.consumer.handle([delivery]))[0]?.action).toBe("retry");
    expect((await c.consumer.handle([delivery]))[0]?.action).toBe("ack");
    const keys = (await c.blobs.list(`payloads/${c.project.project.id}/`))
      .items;
    expect(keys).toEqual([`payloads/${c.project.project.id}/${id(25)}`]);
    const claim = message.body as { blobKey: string };
    expect(
      await c.kv.get(
        `ingest-complete:${c.project.project.id}:${claim.blobKey}`,
      ),
    ).toBeNull();
  });
  it("groups the same SDK error twice separately from a different error", async () => {
    const c = await setup();
    const first = parseEnvelope(
      await readFile(
        new URL("../fixtures/sentry/sdk-2.envelope", import.meta.url),
      ),
    );
    const other = parseEnvelope(
      await readFile(
        new URL("../fixtures/sentry/sdk-3.envelope", import.meta.url),
      ),
    );
    const firstItem = first.items.find((item) => item.headers.type === "event");
    const otherItem = other.items.find((item) => item.headers.type === "event");
    if (!firstItem || !otherItem) throw new Error("Missing SDK events");
    const firstEvent = parseEventPayload(firstItem.payload);
    const otherEvent = parseEventPayload(otherItem.payload);
    expect(
      (await groupEvent(c.project.project.id, firstEvent)).issueId,
    ).not.toBe((await groupEvent(c.project.project.id, otherEvent)).issueId);
    await withConsumer(c.queue, c.consumer.handle, async () => {
      for (const [n, event] of [
        [30, firstEvent],
        [31, firstEvent],
        [32, otherEvent],
      ] as const) {
        const payload = `${JSON.stringify({ event_id: id(n) })}\n{"type":"event"}\n${JSON.stringify({ ...event, event_id: id(n) })}\n`;
        expect((await c.send(payload)).status).toBe(200);
      }
      await vi.waitFor(async () =>
        expect(
          (
            await c.store.issues.list({
              projectId: c.project.project.id,
              sort: "count",
            })
          ).items
            .map((issue) => issue.count)
            .sort(),
        ).toEqual([1, 2]),
      );
    });
  });
  it("recovers staged envelopes into a new queue without duplicating events", async () => {
    const c = await setup();
    expect((await c.send(body(id(77), "recover"))).status).toBe(200);
    const replacement = new MemoryQueue(c.clock);
    expect(await recoverStagedEnvelopes(c.blobs, replacement.producer)).toBe(1);
    await withConsumer(replacement, c.consumer.handle, async () => {
      await vi.waitFor(async () =>
        expect(
          await c.store.events.get(c.project.project.id, id(77) as EventId),
        ).not.toBeNull(),
      );
    });
    expect(await recoverStagedEnvelopes(c.blobs, replacement.producer)).toBe(0);
    const issue = (
      await c.store.issues.list({
        projectId: c.project.project.id,
        sort: "count",
      })
    ).items[0];
    expect(issue?.count).toBe(1);
  });
  it("counts each event item in the configured limit and permits disabling it", async () => {
    const c = await setup({ rateLimit: 2 });
    const payload = `{}\n{"type":"event"}\n{"message":"one"}\n{"type":"event"}\n{"message":"two"}\n`;
    expect((await c.send(payload)).status).toBe(200);
    expect((await c.send(body(id(88), "third"))).status).toBe(429);
    const unlimited = await setup({ rateLimit: null });
    for (let i = 0; i < 65; i++)
      expect((await unlimited.send(body(id(i), "x"))).status).toBe(200);
  });
  it("logs unexpected ingest errors with correlation without credentials", async () => {
    const c = await setup();
    vi.spyOn(c.blobs, "put").mockRejectedValueOnce(
      new Error(`storage failed for ${c.project.key.publicKey}`),
    );
    const app = createIngestApp(c.service, c.logger);
    const result = await app.request(
      `/api/${c.project.project.id}/envelope?sentry_key=${c.project.key.publicKey}`,
      { method: "POST", body: body(id(99), "private") },
    );
    expect(result.status).toBe(500);
    const json = (await result.json()) as { requestId: string };
    expect(c.logger.error).toHaveBeenCalledWith(
      "HTTP request failed",
      expect.objectContaining({
        requestId: json.requestId,
        message: "storage failed for [redacted]",
        stack: expect.any(String),
      }),
    );
  });
  it("logs session-only envelopes at debug level", async () => {
    const c = await setup();
    expect((await c.send('{}\n{"type":"session"}\n{}\n')).status).toBe(200);
    expect(c.logger.debug).toHaveBeenCalledWith(
      "Dropped unsupported envelope items",
      { types: { session: 1 } },
    );
  });
});
