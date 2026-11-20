import {
  type BatchHandler,
  bootstrapProject,
  ConsumerService,
  type Delivery,
  IngestService,
  type Logger,
  type Message,
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
    rateLimit?: number;
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
        attempt: 2,
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
    expect(limited.headers.get("x-sentry-rate-limits")).toContain("error");
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
    expect((await c.send(mismatch)).status).toBe(400);
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
  it("retains staged data when queue publication succeeds but reports an error", async () => {
    const c = await setup();
    const send = c.queue.producer.send.bind(c.queue.producer);
    vi.spyOn(c.queue.producer, "send").mockImplementationOnce(
      async (...args) => {
        await send(...args);
        throw new Error("ambiguous publish");
      },
    );
    expect((await c.send(body(id(9), "ambiguous"))).status).toBe(500);
    const claim = c.sent[0];
    if (!claim) throw new Error("Missing claim");
    await withConsumer(c.queue, c.consumer.handle, async () => {
      await vi.waitFor(async () =>
        expect(
          await c.store.events.get(c.project.project.id, id(9) as never),
        ).not.toBeNull(),
      );
    });
    expect(c.sent).toHaveLength(1);
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
  it("drops unsupported-only envelopes and acknowledges later redelivery", async () => {
    const c = await setup();
    const payload = `${JSON.stringify({ event_id: id(14) })}\n{"type":"transaction"}\n{}\n`;
    expect((await c.send(payload)).status).toBe(200);
    const message = c.sent[0];
    if (!message) throw new Error("Missing claim");
    const delivery: Delivery = {
      id: "unsupported",
      topic: "ingest",
      attempt: 1,
      message,
    };
    expect(await c.consumer.handle([delivery])).toEqual([
      { deliveryId: "unsupported", action: "ack" },
    ]);
    expect(
      (
        await c.store.issues.list({
          projectId: c.project.project.id,
          sort: "count",
        })
      ).items,
    ).toEqual([]);
    c.clock.advance(8 * 24 * 3600 * 1000);
    expect(await c.consumer.handle([delivery])).toEqual([
      { deliveryId: "unsupported", action: "ack" },
    ]);
    expect(c.logger.info).toHaveBeenCalledWith(
      "Dropped unsupported envelope items",
      { count: 1 },
    );
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
});
