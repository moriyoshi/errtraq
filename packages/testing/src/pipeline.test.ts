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
  type RateRejectionConfig,
  RecordHandler,
  readDropped,
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
    recordMode?: "direct" | "grouped";
    rateRejection?: RateRejectionConfig;
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
    recordMode: options.recordMode,
    rateRejection: options.rateRejection,
    queue,
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
  it("does not require consumer KV for a grouped stack with only the new-issue cap", async () => {
    const c = await setup({ recordMode: "grouped" });
    const consumer = new ConsumerService({
      recordMode: "grouped",
      queue: c.queue,
      blobs: c.blobs,
      logger: c.logger,
      rateRejection: { newIssueCap: { issues: 1, windowSec: 60 } },
    });
    expect((await c.send(body(id(728), "cap-only"))).status).toBe(200);
    const message = c.sent[0];
    if (!message) throw new Error("Missing ingest claim");
    expect(
      await consumer.handle([
        { id: "one", topic: "ingest", attempt: 1, message },
      ]),
    ).toEqual([{ deliveryId: "one", action: "ack" }]);
  });
  it("does not call KV from a consumer when rejection is disabled", async () => {
    const c = await setup({ recordMode: "direct" });
    expect((await c.send(body(id(729), "disabled"))).status).toBe(200);
    const message = c.sent[0];
    if (!message) throw new Error("Missing ingest claim");
    const increment = vi.spyOn(c.kv, "increment");
    expect(
      (
        await c.consumer.handle([
          { id: "one", topic: "ingest", attempt: 1, message },
        ])
      )[0]?.action,
    ).toBe("ack");
    expect(increment).not.toHaveBeenCalled();
  });
  it("allows a later-window candidate for an issue rejected in the previous window", async () => {
    const config = { newIssueCap: { issues: 1, windowSec: 60 } };
    const c = await setup({ recordMode: "direct", rateRejection: config });
    const bucket = Math.floor(Date.parse(c.clock.now()) / 60_000);
    await c.kv.increment(
      `rate:new-issues:${c.project.project.id}:${bucket}`,
      1,
      { ttlSec: 120 },
    );
    expect((await c.send(body(id(730), "same issue"))).status).toBe(200);
    c.clock.advance(60_000);
    expect((await c.send(body(id(731), "same issue"))).status).toBe(200);
    const deliveries: Delivery[] = c.sent.map((message, n) => ({
      id: String(n),
      topic: "ingest",
      attempt: 1,
      message,
    }));
    expect(await c.consumer.handle(deliveries)).toEqual([
      { deliveryId: "0", action: "ack" },
      { deliveryId: "1", action: "ack" },
    ]);
    expect(
      await c.store.events.get(c.project.project.id, id(730) as EventId),
    ).toBeNull();
    expect(
      await c.store.events.get(c.project.project.id, id(731) as EventId),
    ).not.toBeNull();
  });
  it("keeps a failed accepted delivery retryable while processing other deliveries", async () => {
    const config = { issueRateLimit: { events: 1, windowSec: 60 } };
    const c = await setup({ recordMode: "direct", rateRejection: config });
    expect((await c.send(body(id(740), "first issue"))).status).toBe(200);
    expect((await c.send(body(id(741), "second issue"))).status).toBe(200);
    const original = c.store.recordEvent.bind(c.store);
    vi.spyOn(c.store, "recordEvent")
      .mockRejectedValueOnce(new Error("temporary"))
      .mockImplementation(original);
    const deliveries: Delivery[] = c.sent.map((message, n) => ({
      id: String(n),
      topic: "ingest",
      attempt: 1,
      message,
    }));
    expect(await c.consumer.handle(deliveries)).toEqual([
      { deliveryId: "0", action: "retry" },
      { deliveryId: "1", action: "ack" },
    ]);
    expect(
      await c.store.events.get(c.project.project.id, id(740) as EventId),
    ).toBeNull();
    expect(
      await c.store.events.get(c.project.project.id, id(741) as EventId),
    ).not.toBeNull();
    const first = c.sent[0]?.body as { blobKey: string };
    expect(await c.blobs.get(first.blobKey)).not.toBeNull();
  });
  it.each(["direct", "grouped"] as const)(
    "charges one per-issue increment across %s deliveries",
    async (mode) => {
      const config = { issueRateLimit: { events: 1, windowSec: 60 } };
      const c = await setup({ recordMode: mode, rateRejection: config });
      for (const event of [701, 702])
        expect((await c.send(body(id(event), "same issue"))).status).toBe(200);
      const increment = vi.spyOn(c.kv, "increment");
      const produce = vi.spyOn(c.queue.producer, "send");
      const eventRead = vi.spyOn(c.store.events, "get");
      const issueRead = vi.spyOn(c.store.issues, "get");
      const deliveries: Delivery[] = c.sent.map((message, n) => ({
        id: String(n),
        topic: "ingest",
        attempt: 1,
        message,
      }));
      expect(await c.consumer.handle(deliveries)).toEqual([
        { deliveryId: "0", action: "ack" },
        { deliveryId: "1", action: "ack" },
      ]);
      const calls = increment.mock.calls.filter(([key]) =>
        key.startsWith("rate:issue:"),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toBe(2);
      if (mode === "direct") {
        expect(
          await c.store.events.get(c.project.project.id, id(701) as EventId),
        ).not.toBeNull();
        expect(
          await c.store.events.get(c.project.project.id, id(702) as EventId),
        ).toBeNull();
      } else {
        expect(eventRead).not.toHaveBeenCalled();
        expect(issueRead).not.toHaveBeenCalled();
        expect(
          produce.mock.calls
            .flatMap(([topic, messages]) =>
              topic === "record" ? messages : [],
            )
            .map((message) => message.key),
        ).toEqual([id(701)]);
      }
    },
  );
  it("does not charge suppressed events and does not reopen a resolved issue when rejecting", async () => {
    const config = { issueRateLimit: { events: 1, windowSec: 60 } };
    const c = await setup({ recordMode: "direct", rateRejection: config });
    expect((await c.send(body(id(710), "same issue"))).status).toBe(200);
    const first = c.sent[0];
    if (!first) throw new Error("Missing first claim");
    expect(
      (
        await c.consumer.handle([
          { id: "first", topic: "ingest", attempt: 1, message: first },
        ])
      )[0]?.action,
    ).toBe("ack");
    const issue = await normalizeEvent(
      c.project.project.id,
      id(710) as EventId,
      c.clock.now(),
      { message: "same issue" },
    );
    const resolved = await c.store.issues.update(
      c.project.project.id,
      issue.event.issueId,
      { status: "resolved", resolvedAt: c.clock.now() },
    );
    c.clock.advance(1000);
    expect((await c.send(body(id(711), "same issue"))).status).toBe(200);
    const second = c.sent[1];
    if (!second) throw new Error("Missing second claim");
    expect(
      (
        await c.consumer.handle([
          { id: "second", topic: "ingest", attempt: 1, message: second },
        ])
      )[0]?.action,
    ).toBe("ack");
    expect(
      await c.store.issues.get(c.project.project.id, issue.event.issueId),
    ).toMatchObject({
      status: "resolved",
      lastSeen: resolved.lastSeen,
      count: 1,
    });
    expect(
      await c.store.events.get(c.project.project.id, id(711) as EventId),
    ).toBeNull();
    expect((await c.send(body(id(712), "suppressed"))).status).toBe(200);
    const third = c.sent[2];
    if (!third) throw new Error("Missing third claim");
    const suppressed = new ConsumerService({
      store: c.store,
      blobs: c.blobs,
      kv: c.kv,
      logger: c.logger,
      rateRejection: config,
      shouldSuppress: () => true,
    });
    const increment = vi.spyOn(c.kv, "increment");
    expect(
      (
        await suppressed.handle([
          { id: "third", topic: "ingest", attempt: 1, message: third },
        ])
      )[0]?.action,
    ).toBe("ack");
    expect(increment).not.toHaveBeenCalled();
  });
  it("retries a delivery without storing accepted events when the dropped counter fails", async () => {
    const config = {
      issueRateLimit: { events: 1, windowSec: 60 },
      onKvFailure: "retry" as const,
    };
    const c = await setup({ recordMode: "direct", rateRejection: config });
    const payload = `{}\n${[720, 721].map((n) => `{"type":"event"}\n${JSON.stringify({ event_id: id(n), message: "same issue" })}\n`).join("")}`;
    expect((await c.send(payload)).status).toBe(200);
    const message = c.sent[0];
    if (!message) throw new Error("Missing ingest claim");
    const original = c.kv.increment.bind(c.kv);
    vi.spyOn(c.kv, "increment").mockImplementation(async (key, by, options) => {
      if (key.startsWith("rate:dropped:"))
        throw new Error("sensitive-provider-response");
      return original(key, by, options);
    });
    expect(
      await c.consumer.handle([
        { id: "one", topic: "ingest", attempt: 1, message },
      ]),
    ).toEqual([{ deliveryId: "one", action: "retry" }]);
    expect(
      await c.store.events.get(c.project.project.id, id(720) as EventId),
    ).toBeNull();
    expect(
      JSON.stringify([
        ...vi.mocked(c.logger.warn).mock.calls,
        ...vi.mocked(c.logger.error).mock.calls,
      ]),
    ).not.toContain("sensitive-provider-response");
  });
  it.each(["direct", "grouped"] as const)(
    "limits events per issue before the %s handoff",
    async (mode) => {
      const config = { issueRateLimit: { events: 2, windowSec: 60 } };
      const c = await setup({ recordMode: mode, rateRejection: config });
      const payload = `{}\n${[1, 2, 3].map((n) => `{"type":"event"}\n${JSON.stringify({ event_id: id(500 + n), message: "limited" })}\n`).join("")}`;
      expect((await c.send(payload)).status).toBe(200);
      const message = c.sent[0];
      if (!message) throw new Error("Missing ingest claim");
      const increment = vi.spyOn(c.kv, "increment");
      const produce = vi.spyOn(c.queue.producer, "send");
      const handler =
        mode === "grouped"
          ? new ConsumerService({
              recordMode: "grouped",
              queue: c.queue,
              blobs: c.blobs,
              kv: c.kv,
              logger: c.logger,
              rateRejection: config,
            })
          : c.consumer;
      expect(
        await handler.handle([
          { id: "one", topic: "ingest", attempt: 1, message },
        ]),
      ).toEqual([{ deliveryId: "one", action: "ack" }]);
      const issue = await normalizeEvent(
        c.project.project.id,
        id(501) as EventId,
        c.clock.now(),
        { message: "limited" },
      );
      expect(
        await readDropped(
          c.kv,
          config,
          c.project.project.id,
          issue.event.issueId,
          c.clock.now(),
        ),
      ).toEqual({ count: 1, windowSec: 60 });
      expect(
        increment.mock.calls.filter(([key]) => key.startsWith("rate:issue:")),
      ).toHaveLength(1);
      if (mode === "direct") {
        expect(
          (await c.store.issues.get(c.project.project.id, issue.event.issueId))
            ?.count,
        ).toBe(2);
        expect(
          await c.store.events.get(c.project.project.id, id(503) as EventId),
        ).toBeNull();
      } else {
        const messages = produce.mock.calls.flatMap(([topic, sent]) =>
          topic === "record" ? sent : [],
        );
        expect(messages.map((item) => item.key)).toEqual([id(501), id(502)]);
        expect(
          await c.store.issues.get(c.project.project.id, issue.event.issueId),
        ).toBeNull();
      }
    },
  );
  it("caps new issues in direct mode while allowing further events for an admitted issue", async () => {
    const config = { newIssueCap: { issues: 1, windowSec: 60 } };
    const c = await setup({ recordMode: "direct", rateRejection: config });
    const events = [
      [601, "first"],
      [602, "second"],
      [603, "first"],
    ] as const;
    const payload = `{}\n${events.map(([n, message]) => `{"type":"event"}\n${JSON.stringify({ event_id: id(n), message })}\n`).join("")}`;
    expect((await c.send(payload)).status).toBe(200);
    const message = c.sent[0];
    if (!message) throw new Error("Missing ingest claim");
    const issueRead = vi.spyOn(c.store.issues, "get");
    expect(
      (
        await c.consumer.handle([
          { id: "one", topic: "ingest", attempt: 1, message },
        ])
      )[0]?.action,
    ).toBe("ack");
    expect(
      await c.store.events.get(c.project.project.id, id(601) as EventId),
    ).not.toBeNull();
    expect(
      await c.store.events.get(c.project.project.id, id(602) as EventId),
    ).toBeNull();
    expect(
      await c.store.events.get(c.project.project.id, id(603) as EventId),
    ).not.toBeNull();
    expect(issueRead).toHaveBeenCalledTimes(2);
  });
  it.each(["allow", "retry"] as const)(
    "handles consumer KV failure with %s policy without leaking its details",
    async (onKvFailure) => {
      const c = await setup({
        recordMode: "direct",
        rateRejection: {
          issueRateLimit: { events: 1, windowSec: 60 },
          onKvFailure,
        },
      });
      expect((await c.send(body(id(610), "failure"))).status).toBe(200);
      const message = c.sent[0];
      if (!message) throw new Error("Missing ingest claim");
      vi.spyOn(c.kv, "increment").mockRejectedValue(
        new Error("private-secret"),
      );
      expect(
        (
          await c.consumer.handle([
            { id: "one", topic: "ingest", attempt: 1, message },
          ])
        )[0]?.action,
      ).toBe(onKvFailure === "allow" ? "ack" : "retry");
      expect(
        JSON.stringify([
          ...vi.mocked(c.logger.warn).mock.calls,
          ...vi.mocked(c.logger.error).mock.calls,
        ]),
      ).not.toContain("private-secret");
    },
  );
  it("caps candidate new issues in the grouped record handler and counts dropped records", async () => {
    const c = await setup({ recordMode: "grouped" });
    const rateRejection = { newIssueCap: { issues: 1, windowSec: 60 } };
    const handler = new RecordHandler({
      store: c.store,
      blobs: c.blobs,
      kv: c.kv,
      logger: c.logger,
      rateRejection,
    });
    const a = await normalizeEvent(
      c.project.project.id,
      id(71) as EventId,
      c.clock.now(),
      { message: "first issue" },
    );
    const b = await normalizeEvent(
      c.project.project.id,
      id(72) as EventId,
      c.clock.now(),
      { message: "second issue" },
    );
    const b2 = await normalizeEvent(
      c.project.project.id,
      id(73) as EventId,
      c.clock.now(),
      { message: "second issue" },
    );
    const toDelivery = (n: string, value: typeof a): Delivery => ({
      id: n,
      topic: "record",
      attempt: 1,
      message: {
        key: value.event.eventId,
        groupKey: value.event.issueId,
        body: JSON.parse(JSON.stringify({ version: 1, ...value })),
      },
    });
    const get = vi.spyOn(c.store.issues, "get");
    const increment = vi.spyOn(c.kv, "increment");
    expect(
      await handler.handle([
        toDelivery("a", a),
        toDelivery("b", b),
        toDelivery("b2", b2),
      ]),
    ).toEqual([
      { deliveryId: "a", action: "ack" },
      { deliveryId: "b", action: "ack" },
      { deliveryId: "b2", action: "ack" },
    ]);
    expect(
      await c.store.events.get(c.project.project.id, a.event.eventId),
    ).not.toBeNull();
    expect(
      await c.store.events.get(c.project.project.id, b.event.eventId),
    ).toBeNull();
    expect(
      await c.store.events.get(c.project.project.id, b2.event.eventId),
    ).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
    expect(increment).toHaveBeenCalledTimes(3);
    expect(
      await readDropped(
        c.kv,
        rateRejection,
        c.project.project.id,
        b.event.issueId,
        c.clock.now(),
      ),
    ).toEqual({ count: 2, windowSec: 60 });
    const existing = await normalizeEvent(
      c.project.project.id,
      id(74) as EventId,
      c.clock.now(),
      { message: "first issue" },
    );
    expect(await handler.handle([toDelivery("existing", existing)])).toEqual([
      { deliveryId: "existing", action: "ack" },
    ]);
    expect(
      await c.store.events.get(c.project.project.id, existing.event.eventId),
    ).not.toBeNull();
    expect(increment).toHaveBeenCalledTimes(3);
  });
  it("rechecks issue existence between chunks without charging the same candidate twice", async () => {
    const c = await setup({ recordMode: "grouped" });
    const config = { newIssueCap: { issues: 1, windowSec: 60 } };
    const handler = new RecordHandler({
      store: c.store,
      blobs: c.blobs,
      kv: c.kv,
      logger: c.logger,
      rateRejection: config,
    });
    const timestamp = c.clock.now();
    const bucket = Math.floor(Date.parse(timestamp) / 60_000);
    await c.kv.increment(
      `rate:new-issues:${c.project.project.id}:${bucket}`,
      1,
      { ttlSec: 120 },
    );
    const get = vi.spyOn(c.store.issues, "get");
    const increment = vi.spyOn(c.kv, "increment");
    const deliveries: Delivery[] = [];
    for (let n = 0; n < 11; n++) {
      const value = await normalizeEvent(
        c.project.project.id,
        id(200 + n) as EventId,
        timestamp,
        { message: "one issue" },
      );
      deliveries.push({
        id: String(n),
        topic: "record",
        attempt: 1,
        message: {
          key: value.event.eventId,
          groupKey: value.event.issueId,
          body: JSON.parse(JSON.stringify({ version: 1, ...value })),
        },
      });
    }
    expect(
      (await handler.handle(deliveries)).every(
        (result) => result.action === "ack",
      ),
    ).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
    expect(
      increment.mock.calls.filter(([key]) =>
        key.startsWith("rate:new-issues:"),
      ),
    ).toHaveLength(1);
    const group = deliveries[0]?.message.groupKey;
    if (!group) throw new Error("Missing group");
    expect(
      await readDropped(c.kv, config, c.project.project.id, group, timestamp),
    ).toEqual({ count: 11, windowSec: 60 });
  });
  it("can admit a later record for the same new issue in a later cap window", async () => {
    const c = await setup({ recordMode: "grouped" });
    const config = { newIssueCap: { issues: 1, windowSec: 60 } };
    const firstTime = c.clock.now();
    const laterTime = "2024-01-01T00:01:00.000Z" as typeof firstTime;
    const bucket = Math.floor(Date.parse(firstTime) / 60_000);
    await c.kv.increment(
      `rate:new-issues:${c.project.project.id}:${bucket}`,
      1,
      { ttlSec: 120 },
    );
    const first = await normalizeEvent(
      c.project.project.id,
      id(300) as EventId,
      firstTime,
      { message: "same issue" },
    );
    const later = await normalizeEvent(
      c.project.project.id,
      id(301) as EventId,
      laterTime,
      { message: "same issue" },
    );
    const delivery = (name: string, value: typeof first): Delivery => ({
      id: name,
      topic: "record",
      attempt: 1,
      message: {
        key: value.event.eventId,
        groupKey: value.event.issueId,
        body: JSON.parse(JSON.stringify({ version: 1, ...value })),
      },
    });
    const handler = new RecordHandler({
      store: c.store,
      blobs: c.blobs,
      kv: c.kv,
      logger: c.logger,
      rateRejection: config,
    });
    expect(
      await handler.handle([
        delivery("first", first),
        delivery("later", later),
      ]),
    ).toEqual([
      { deliveryId: "first", action: "ack" },
      { deliveryId: "later", action: "ack" },
    ]);
    expect(
      await c.store.events.get(c.project.project.id, first.event.eventId),
    ).toBeNull();
    expect(
      await c.store.events.get(c.project.project.id, later.event.eventId),
    ).not.toBeNull();
  });
  it("does not reuse an admitted group for a different project across chunks", async () => {
    const c = await setup({ recordMode: "grouped" });
    const time = c.clock.now();
    const deliveries: Delivery[] = [];
    for (let n = 0; n < 11; n++) {
      const value = await normalizeEvent(
        c.project.project.id,
        id(400 + n) as EventId,
        time,
        { message: "same group" },
      );
      if (n === 10) {
        value.occurrence.projectId = "999" as typeof value.occurrence.projectId;
        value.event.projectId = "999" as typeof value.event.projectId;
      }
      deliveries.push({
        id: String(n),
        topic: "record",
        attempt: 1,
        message: {
          key: value.event.eventId,
          groupKey: value.event.issueId,
          body: JSON.parse(JSON.stringify({ version: 1, ...value })),
        },
      });
    }
    const handler = new RecordHandler({
      store: c.store,
      blobs: c.blobs,
      kv: c.kv,
      logger: c.logger,
      rateRejection: { newIssueCap: { issues: 1, windowSec: 60 } },
    });
    const result = await handler.handle(deliveries);
    expect(result.slice(0, 10).every((item) => item.action === "ack")).toBe(
      true,
    );
    expect(result[10]).toEqual({ deliveryId: "10", action: "retry" });
    expect(
      await c.store.events.get(
        "999" as typeof c.project.project.id,
        id(410) as EventId,
      ),
    ).toBeNull();
  });
  it.each(["allow", "retry"] as const)(
    "handles grouped new-issue KV failure with %s policy",
    async (onKvFailure) => {
      const c = await setup({ recordMode: "grouped" });
      const event = await normalizeEvent(
        c.project.project.id,
        id(75) as EventId,
        c.clock.now(),
        { message: "failure" },
      );
      const delivery: Delivery = {
        id: "d",
        topic: "record",
        attempt: 1,
        message: {
          key: event.event.eventId,
          groupKey: event.event.issueId,
          body: JSON.parse(JSON.stringify({ version: 1, ...event })),
        },
      };
      vi.spyOn(c.kv, "increment").mockRejectedValue(
        new Error("private-secret"),
      );
      const handler = new RecordHandler({
        store: c.store,
        blobs: c.blobs,
        kv: c.kv,
        logger: c.logger,
        rateRejection: {
          newIssueCap: { issues: 1, windowSec: 60 },
          onKvFailure,
        },
      });
      expect(await handler.handle([delivery])).toEqual([
        { deliveryId: "d", action: onKvFailure === "allow" ? "ack" : "retry" },
      ]);
      expect(
        await c.store.events.get(c.project.project.id, event.event.eventId),
      ).toEqual(onKvFailure === "allow" ? expect.anything() : null);
      expect(JSON.stringify(vi.mocked(c.logger.warn).mock.calls)).not.toContain(
        "private-secret",
      );
    },
  );
  it("stores oversized normalized records as durable claim checks", async () => {
    const c = await setup({ recordMode: "grouped" });
    c.queue.capabilities.maxBytes = 500;
    expect(
      (
        await c.send(
          body(id(18), "large", { extra: { value: "x".repeat(3000) } }),
        )
      ).status,
    ).toBe(200);
    const message = c.sent[0];
    if (!message) throw new Error("missing ingest message");
    const send = vi.spyOn(c.queue.producer, "send");
    expect(
      await c.consumer.handle([
        { id: "in", topic: "ingest", attempt: 1, message },
      ]),
    ).toEqual([{ deliveryId: "in", action: "ack" }]);
    const queued = send.mock.calls[0]?.[1][0];
    if (!queued) throw new Error("missing record message");
    expect(queued.body).toMatchObject({
      version: 1,
      blobKey: expect.stringContaining("payloads/records/"),
    });
    const record = new RecordHandler({
      store: c.store,
      blobs: c.blobs,
      logger: c.logger,
    });
    expect(
      await record.handle([
        { id: "out", topic: "record", attempt: 1, message: queued },
      ]),
    ).toEqual([{ deliveryId: "out", action: "ack" }]);
    expect(
      await c.store.events.get(c.project.project.id, id(18) as EventId),
    ).not.toBeNull();
  });
  it("retains the staged envelope when publishing a grouped record fails", async () => {
    const c = await setup({ recordMode: "grouped" });
    expect((await c.send(body(id(19), "retry"))).status).toBe(200);
    const message = c.sent[0];
    if (!message) throw new Error("missing ingest message");
    const send = vi
      .spyOn(c.queue.producer, "send")
      .mockRejectedValueOnce(new Error("unavailable"));
    const delivery: Delivery = {
      id: "delivery",
      topic: "ingest",
      attempt: 1,
      message,
    };
    expect(await c.consumer.handle([delivery])).toEqual([
      { deliveryId: "delivery", action: "retry" },
    ]);
    const claim = message.body as { blobKey: string };
    expect(await c.blobs.get(claim.blobKey)).not.toBeNull();
    expect(await c.consumer.handle([{ ...delivery, attempt: 2 }])).toEqual([
      { deliveryId: "delivery", action: "ack" },
    ]);
    expect(await c.blobs.get(claim.blobKey)).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("records valid prefixes, isolates poison and keeps other issue groups moving", async () => {
    const c = await setup({ recordMode: "grouped" });
    const record = new RecordHandler({
      store: c.store,
      blobs: c.blobs,
      logger: c.logger,
    });
    const first = await normalizeEvent(
      c.project.project.id,
      id(21) as EventId,
      c.clock.now(),
      { message: "same" },
    );
    const later = await normalizeEvent(
      c.project.project.id,
      id(22) as EventId,
      c.clock.now(),
      { message: "same" },
    );
    const other = await normalizeEvent(
      c.project.project.id,
      id(23) as EventId,
      c.clock.now(),
      { message: "other" },
    );
    const delivery = (name: string, value: typeof first): Delivery => ({
      id: name,
      topic: "record",
      attempt: 1,
      message: {
        key: value.event.eventId,
        groupKey: value.event.issueId,
        body: JSON.parse(JSON.stringify({ version: 1, ...value })),
      },
    });
    const good = delivery("first", first),
      after = delivery("later", later),
      independent = delivery("other", other);
    const poison: Delivery = {
      id: "poison",
      topic: "record",
      attempt: 1,
      message: { key: "broken", groupKey: first.event.issueId, body: {} },
    };
    const outcome = await record.handle([good, independent, poison, after]);
    expect(outcome).toEqual([
      { deliveryId: "first", action: "ack" },
      { deliveryId: "other", action: "ack" },
      { deliveryId: "poison", action: "retry" },
      { deliveryId: "later", action: "retry" },
    ]);
    expect(
      await c.store.events.get(c.project.project.id, first.event.eventId),
    ).not.toBeNull();
    expect(
      await c.store.events.get(c.project.project.id, later.event.eventId),
    ).toBeNull();
    expect(
      await c.store.events.get(c.project.project.id, other.event.eventId),
    ).not.toBeNull();
    await record.handle([
      { ...poison, attempt: 2 },
      { ...after, attempt: 2 },
    ]);
    expect(
      vi
        .mocked(c.logger.error)
        .mock.calls.filter(
          ([message]) => message === "Invalid record delivery",
        ),
    ).toHaveLength(1);
  });
  it.each(["direct", "grouped"] as const)(
    "records interleaved issues and duplicates in %s mode",
    async (recordMode) => {
      const c = await setup({ recordMode });
      const record = new RecordHandler({
        store: c.store,
        blobs: c.blobs,
        logger: c.logger,
      });
      await withConsumer(
        c.queue,
        async (batch) => {
          const result: Awaited<ReturnType<BatchHandler>> = [];
          for (const topic of ["ingest", "record"]) {
            const items = batch.filter((item) => item.topic === topic);
            if (items.length)
              result.push(
                ...(await (topic === "ingest"
                  ? c.consumer.handle(items)
                  : record.handle(items))),
              );
          }
          return result;
        },
        async () => {
          for (const payload of [
            body(id(1), "first"),
            body(id(2), "second"),
            body(id(3), "first"),
            body(id(1), "first"),
          ])
            expect((await c.send(payload)).status).toBe(200);
          await vi.waitFor(async () => {
            const issues = await c.store.issues.list({
              projectId: c.project.project.id,
              sort: "lastSeen",
            });
            expect(issues.items.map((item) => item.count).sort()).toEqual([
              1, 2,
            ]);
          });
          if (recordMode === "grouped") {
            await c.queue.producer.send("record", [
              { key: "poison", groupKey: "bad", body: {} },
            ]);
            await vi.waitFor(() =>
              expect(c.logger.error).toHaveBeenCalledWith(
                "Invalid record delivery",
                expect.anything(),
              ),
            );
            expect(
              vi
                .mocked(c.logger.error)
                .mock.calls.filter(
                  ([message]) => message === "Invalid record delivery",
                ),
            ).toHaveLength(1);
          }
        },
      );
    },
  );
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
  it("acknowledges a recovery claim when the concurrent consumer has already deleted its blob", async () => {
    const c = await setup();
    expect((await c.send(body(id(76), "race"))).status).toBe(200);
    const message = c.sent[0];
    if (!message) throw new Error("missing claim");
    const recovered: Message[] = [];
    const producer = {
      send: async (_topic: string, messages: Message[]) => {
        recovered.push(...messages);
      },
    };
    expect(
      await recoverStagedEnvelopes(c.blobs, producer, c.logger, {
        now: c.clock.now(),
        minimumAgeMs: 600000,
      }),
    ).toBe(0);
    expect(await recoverStagedEnvelopes(c.blobs, producer)).toBe(1);
    const original: Delivery = {
      id: "original",
      topic: "ingest",
      attempt: 1,
      message,
    };
    expect((await c.consumer.handle([original]))[0]?.action).toBe("ack");
    const duplicate = recovered[0];
    if (!duplicate) throw new Error("missing recovered claim");
    expect(
      await c.consumer.handle([
        { id: "recovered", topic: "ingest", attempt: 1, message: duplicate },
      ]),
    ).toEqual([{ deliveryId: "recovered", action: "ack" }]);
    expect(
      (
        await c.store.issues.list({
          projectId: c.project.project.id,
          sort: "count",
        })
      ).items[0]?.count,
    ).toBe(1);
    expect(c.logger.error).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent original and recovered deliveries", async () => {
    const c = await setup();
    expect((await c.send(body(id(75), "concurrent"))).status).toBe(200);
    const original = c.sent[0];
    if (!original) throw new Error("missing original claim");
    const recovered: Message[] = [];
    await recoverStagedEnvelopes(c.blobs, {
      send: async (_topic, messages) => {
        recovered.push(...messages);
      },
    });
    const copy = recovered[0];
    if (!copy) throw new Error("missing recovered claim");
    const result = await Promise.all([
      c.consumer.handle([
        { id: "original", topic: "ingest", attempt: 1, message: original },
      ]),
      c.consumer.handle([
        { id: "recovered", topic: "ingest", attempt: 1, message: copy },
      ]),
    ]);
    expect(result.map((items) => items[0]?.action)).toEqual(["ack", "ack"]);
    expect(
      (
        await c.store.issues.list({
          projectId: c.project.project.id,
          sort: "count",
        })
      ).items[0]?.count,
    ).toBe(1);
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
