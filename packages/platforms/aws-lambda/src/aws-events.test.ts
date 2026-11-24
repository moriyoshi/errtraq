import { gzipSync } from "node:zlib";
import {
  bootstrapProject,
  CRON_JOBS,
  type EventId,
  type Logger,
  type Message,
  type QueueProducer,
} from "@moriyoshi/errtraq-core";
import { SqsQueue } from "@moriyoshi/errtraq-queue-sqs/runtime";
import {
  DeterministicIdGen,
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@moriyoshi/errtraq-testing";
import { describe, expect, it, vi } from "vitest";
import {
  eventBridgeConstantInput,
  eventBridgeScheduledEvent,
  eventBridgeSchedulerEmptyEvent,
  FIFO_QUEUE_ARN,
  functionUrlEvent,
  STANDARD_QUEUE_ARN,
  sqsFifoRecord,
  sqsStandardRecord,
  sqsStandardSecondRecord,
} from "./aws-event-fixtures.js";
import { createHandler } from "./handler.js";

const silent = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
const eventId = "0123456789abcdef0123456789abcdef";
const envelope = (message: string) =>
  `${JSON.stringify({ event_id: eventId })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: eventId, message })}\n`;

async function setup() {
  const store = new MemoryActiveStore();
  const blob = new MemoryBlobStore();
  const kv = new MemoryKV();
  const memory = new MemoryQueue();
  const project = await bootstrapProject({
    store,
    kv,
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "project",
  });
  const sent: Message[] = [];
  const producer: QueueProducer = {
    send: async (_topic, messages) => {
      sent.push(...structuredClone(messages));
    },
  };
  const logger = silent();
  const ingest = createHandler({
    roles: ["ingest"],
    http: ["ingest"],
    adapters: { store, blob, kv, queue: { ...memory, producer } },
    logger,
  });
  return { store, blob, kv, project, sent, logger, ingest };
}
const sqs = (
  eventSource: string,
  topics: string[],
  fetcher: typeof fetch = vi.fn(),
) =>
  new SqsQueue({
    region: "us-east-2",
    environment: {
      AWS_ACCESS_KEY_ID: "fixture",
      AWS_SECRET_ACCESS_KEY: "fixture",
    },
    bindings: {},
    topics: {},
    consumers: [{ physical: "shared", topics, eventSource }],
    fetch: fetcher,
    sleep: async () => {},
    logger: { warn: vi.fn(), error: vi.fn() },
  });

describe("Lambda function URL events (payload format 2.0)", () => {
  it("accepts a base64-encoded gzip envelope body and queues one claim", async () => {
    const c = await setup();
    const body = Buffer.from(
      gzipSync(envelope("from a function URL")),
    ).toString("base64");
    const result = (await c.ingest(
      functionUrlEvent({
        method: "POST",
        rawPath: `/api/${c.project.project.id}/envelope/`,
        rawQueryString: `sentry_key=${c.project.key.publicKey}&sentry_version=7`,
        headers: {
          "content-type": "application/x-sentry-envelope",
          "content-encoding": "gzip",
        },
        body,
        isBase64Encoded: true,
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBe(200);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]?.key).toBe(eventId);
  });
  it("accepts a plain-text body and rejects an unknown DSN key", async () => {
    const c = await setup();
    const request = (key: string) =>
      functionUrlEvent({
        method: "POST",
        rawPath: `/api/${c.project.project.id}/envelope/`,
        rawQueryString: `sentry_key=${key}`,
        headers: { "content-type": "application/x-sentry-envelope" },
        body: envelope("plain"),
      });
    expect(await c.ingest(request(c.project.key.publicKey))).toMatchObject({
      statusCode: 200,
    });
    expect(await c.ingest(request("0".repeat(32)))).toMatchObject({
      statusCode: 403,
    });
    expect(c.sent).toHaveLength(1);
  });
  it("rejects a corrupt base64 gzip body without queueing", async () => {
    const c = await setup();
    const result = (await c.ingest(
      functionUrlEvent({
        method: "POST",
        rawPath: `/api/${c.project.project.id}/envelope/`,
        rawQueryString: `sentry_key=${c.project.key.publicKey}`,
        headers: {
          "content-type": "application/x-sentry-envelope",
          "content-encoding": "gzip",
        },
        body: Buffer.from("not gzip").toString("base64"),
        isBase64Encoded: true,
      }),
    )) as { statusCode: number };
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
    expect(result.statusCode).toBeLessThan(500);
    expect(c.sent).toHaveLength(0);
  });
});

describe("Lambda SQS events", () => {
  async function consumer(
    c: Awaited<ReturnType<typeof setup>>,
    queue: SqsQueue,
    roles: ("consumer" | "record")[] = ["consumer"],
    recordMode?: "grouped",
  ) {
    return createHandler({
      roles,
      http: [],
      recordMode,
      adapters: { store: c.store, blob: c.blob, kv: c.kv, queue },
      logger: c.logger,
    });
  }
  it("processes a standard batch and reports poison records as partial failures", async () => {
    const c = await setup();
    await c.ingest(
      functionUrlEvent({
        method: "POST",
        rawPath: `/api/${c.project.project.id}/envelope/`,
        rawQueryString: `sentry_key=${c.project.key.publicKey}`,
        headers: { "content-type": "application/x-sentry-envelope" },
        body: envelope("queued"),
      }),
    );
    const message = c.sent[0] as Message;
    const handler = await consumer(
      c,
      sqs(STANDARD_QUEUE_ARN, ["ingest", "record"]),
    );
    const result = await handler({
      Records: [
        sqsStandardRecord(JSON.stringify({ topic: "ingest", message })),
        // The documentation's own body is not an errtraq envelope.
        sqsStandardSecondRecord("Test message."),
      ],
    });
    expect(result).toEqual({
      batchItemFailures: [
        { itemIdentifier: "2e1424d4-f796-459a-8184-9c92662be6da" },
      ],
    });
    expect(
      await c.store.events.get(c.project.project.id, eventId as EventId),
    ).not.toBeNull();
  });
  it("retries a delivery whose topic has no handler in this function", async () => {
    const c = await setup();
    const handler = await consumer(
      c,
      sqs(STANDARD_QUEUE_ARN, ["ingest", "record"]),
    );
    const result = await handler({
      Records: [
        sqsStandardRecord(
          JSON.stringify({
            topic: "record",
            message: { key: "k", body: null },
          }),
        ),
      ],
    });
    expect(result).toEqual({
      batchItemFailures: [
        { itemIdentifier: "059f36b4-87a3-44ab-83d2-661975830a7d" },
      ],
    });
  });
  it("accepts FIFO records with group, deduplication and sequence attributes", async () => {
    const c = await setup();
    const body = (key: string, group: string) =>
      JSON.stringify({
        topic: "record",
        message: { key, groupKey: group, body: null },
      });
    const handler = await consumer(c, sqs(FIFO_QUEUE_ARN, ["record"]), [
      "consumer",
    ]);
    // No record handler in this function: every FIFO delivery must be retried, and ids keep order.
    const result = (await handler({
      Records: [
        sqsFifoRecord(body("a", "1"), { messageId: "m1", sequence: 0 }),
        sqsFifoRecord(body("b", "1"), {
          messageId: "m2",
          dedup: "2",
          sequence: 1,
        }),
        sqsFifoRecord(body("c", "2"), {
          messageId: "m3",
          group: "2",
          dedup: "3",
          sequence: 2,
        }),
      ],
    })) as { batchItemFailures: { itemIdentifier: string }[] };
    expect(result.batchItemFailures.map((item) => item.itemIdentifier)).toEqual(
      ["m1", "m2", "m3"],
    );
  });
  it("fails a FIFO record whose group differs from its envelope and every later record", async () => {
    const c = await setup();
    const handler = await consumer(
      c,
      sqs(FIFO_QUEUE_ARN, ["record"]),
      ["record"],
      "grouped",
    );
    const good = JSON.stringify({
      topic: "record",
      message: { key: "x", groupKey: "1", body: null },
    });
    const result = (await handler({
      Records: [
        sqsFifoRecord(
          JSON.stringify({
            topic: "record",
            message: { key: "y", groupKey: "other", body: null },
          }),
          { messageId: "m1", sequence: 0 },
        ),
        sqsFifoRecord(good, { messageId: "m2", dedup: "2", sequence: 1 }),
      ],
    })) as { batchItemFailures: { itemIdentifier: string }[] };
    expect(result.batchItemFailures.map((item) => item.itemIdentifier)).toEqual(
      ["m1", "m2"],
    );
  });
});

describe("EventBridge scheduled events", () => {
  const cron = () => {
    const cronHandler = vi.fn(async (_name: string, _firedAt: string) => {});
    const logger = silent();
    const handler = createHandler({
      roles: ["cron"],
      http: [],
      adapters: {},
      cronHandler,
      logger,
    });
    return { handler, cronHandler, logger };
  };
  it("dispatches each known job from the constant input the Terraform module configures", async () => {
    const { handler, cronHandler } = cron();
    for (const job of CRON_JOBS)
      await handler(eventBridgeConstantInput(job.name));
    expect(cronHandler.mock.calls.map(([name]) => name)).toEqual(
      CRON_JOBS.map((job) => job.name),
    );
  });
  it("acknowledges the default scheduled-event shape and the empty Scheduler event without running a job", async () => {
    const { handler, cronHandler, logger } = cron();
    expect(await handler(eventBridgeScheduledEvent)).toBeUndefined();
    expect(await handler(eventBridgeSchedulerEmptyEvent)).toBeUndefined();
    expect(
      await handler(eventBridgeConstantInput("not-a-job")),
    ).toBeUndefined();
    expect(cronHandler).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(3);
  });
  it("does not mistake a function URL request for a cron tick when roles are combined", async () => {
    const cronHandler = vi.fn(async () => {});
    const c = await setup();
    const handler = createHandler({
      roles: ["ingest", "cron"],
      http: ["ingest"],
      adapters: {
        store: c.store,
        blob: c.blob,
        kv: c.kv,
        queue: new MemoryQueue(),
      },
      cronHandler,
      logger: c.logger,
    });
    const result = await handler(
      functionUrlEvent({ method: "OPTIONS", rawPath: "/api/1/envelope/" }),
    );
    expect(result).toMatchObject({ statusCode: 204 });
    expect(cronHandler).not.toHaveBeenCalled();
  });
});
