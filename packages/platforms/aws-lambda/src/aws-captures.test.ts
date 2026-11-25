import { readFileSync } from "node:fs";
import {
  bootstrapProject,
  CRON_JOBS,
  type Logger,
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
  eventBridgeScheduledEvent,
  FIFO_QUEUE_ARN,
  functionUrlEvent,
  STANDARD_QUEUE_ARN,
  sqsFifoRecord,
  sqsStandardRecord,
} from "./aws-event-fixtures.js";
import { createHandler } from "./handler.js";

// biome-ignore lint/suspicious/noExplicitAny: captured JSON is deliberately untyped.
type Capture = Record<string, any>;
const capture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/captured/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Capture;

const keys = (value: object) => Object.keys(value).sort();
const silent = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
/** Failure message that names exactly which keys differ. */
const diff = (label: string, builder: object, real: object) => {
  const b = new Set(keys(builder));
  const r = new Set(keys(real));
  return {
    label,
    onlyInBuilder: [...b].filter((k) => !r.has(k)),
    onlyInCapture: [...r].filter((k) => !b.has(k)),
  };
};
const same = (label: string) => ({
  label,
  onlyInBuilder: [],
  onlyInCapture: [],
});

describe("builder parity with real captures: SQS", () => {
  const standard = capture("sqs-standard");
  const fifo = capture("sqs-fifo");
  it("standard record keys, attribute names and formats match", () => {
    expect(Object.keys(standard)).toEqual(["Records"]);
    const real = standard.Records[0];
    const built = sqsStandardRecord("x");
    expect(diff("record", built, real)).toEqual(same("record"));
    expect(diff("attributes", built.attributes, real.attributes)).toEqual(
      same("attributes"),
    );
    for (const name of [
      "ApproximateReceiveCount",
      "SentTimestamp",
      "ApproximateFirstReceiveTimestamp",
    ]) {
      expect(typeof real.attributes[name]).toBe("string");
      expect(typeof (built.attributes as Record<string, unknown>)[name]).toBe(
        "string",
      );
    }
    expect(real.attributes.SentTimestamp).toMatch(/^\d{13}$/);
    expect(built.attributes.SentTimestamp).toMatch(/^\d{13}$/);
    expect(real.attributes).not.toHaveProperty("SequenceNumber");
    expect(real.eventSource).toBe(built.eventSource);
    expect(real.eventSourceARN).toMatch(/^arn:aws:sqs:[a-z0-9-]+:\d{12}:.+$/);
    expect(built.eventSourceARN).toMatch(/^arn:aws:sqs:[a-z0-9-]+:\d{12}:.+$/);
    expect(real.md5OfBody).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof real.messageAttributes).toBe("object");
    expect(built.md5OfBody).toMatch(/^[0-9a-f]{32}$/);
  });
  it("FIFO record keys, attribute names and formats match", () => {
    expect(fifo.Records).toHaveLength(3);
    const built = sqsFifoRecord("x", { messageId: "m" });
    for (const real of fifo.Records) {
      expect(diff("record", built, real)).toEqual(same("record"));
      expect(diff("attributes", built.attributes, real.attributes)).toEqual(
        same("attributes"),
      );
      expect(real.attributes.SequenceNumber).toMatch(/^\d{20}$/);
      expect(built.attributes.SequenceNumber).toMatch(/^\d{20}$/);
      expect(real.eventSourceARN).toMatch(/\.fifo$/);
      expect(built.eventSourceARN).toMatch(/\.fifo$/);
      expect(typeof real.attributes.MessageGroupId).toBe("string");
      expect(typeof real.attributes.MessageDeduplicationId).toBe("string");
    }
  });
});

describe("builder parity with real captures: Function URL", () => {
  const post = capture("function-url-post");
  const get = capture("function-url-get");
  const options = capture("function-url-options");
  it("top-level keys, requestContext and http shape match", () => {
    const builtPost = functionUrlEvent({
      method: "POST",
      rawPath: "/api/1/envelope/",
      rawQueryString: "sentry_key=0000",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: "eA==",
      isBase64Encoded: true,
    });
    const builtGet = functionUrlEvent({
      method: "GET",
      rawPath: "/api/0/projects/",
      rawQueryString: "cursor=1",
    });
    const builtOptions = functionUrlEvent({
      method: "OPTIONS",
      rawPath: "/api/1/envelope/",
    });
    for (const [real, built] of [
      [post, builtPost],
      [get, builtGet],
      [options, builtOptions],
    ] as const) {
      expect(diff("event", built, real)).toEqual(same("event"));
      expect(
        diff("requestContext", built.requestContext, real.requestContext),
      ).toEqual(same("requestContext"));
      expect(
        diff(
          "requestContext.http",
          built.requestContext.http,
          real.requestContext.http,
        ),
      ).toEqual(same("requestContext.http"));
      expect(real.version).toBe("2.0");
      expect(real.routeKey).toBe("$default");
      expect(real.requestContext.time).toMatch(
        /^\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000$/,
      );
      expect(built.requestContext.time).toMatch(
        /^\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000$/,
      );
      expect(typeof real.requestContext.timeEpoch).toBe("number");
      expect(typeof real.isBase64Encoded).toBe("boolean");
      expect(typeof built.isBase64Encoded).toBe("boolean");
      // Header names are lower-case and the service-added headers are present in both.
      for (const name of Object.keys(real.headers))
        expect(name).toBe(name.toLowerCase());
      for (const name of [
        "x-forwarded-proto",
        "x-forwarded-port",
        "x-forwarded-for",
        "x-amzn-tls-version",
        "x-amzn-tls-cipher-suite",
        "x-amzn-trace-id",
        "host",
      ]) {
        expect(real.headers).toHaveProperty(name);
        expect(built.headers).toHaveProperty(name);
      }
      // http.path has no trailing slash although rawPath keeps it.
      expect(real.rawPath).toMatch(/\/$/);
      expect(real.requestContext.http.path).toBe(
        real.rawPath.replace(/\/$/, ""),
      );
      expect(built.requestContext.http.path).toBe(
        built.rawPath.replace(/\/$/, ""),
      );
    }
    expect(post.isBase64Encoded).toBe(true);
    expect(builtPost.isBase64Encoded).toBe(true);
    expect(get).not.toHaveProperty("body");
    expect(options).not.toHaveProperty("body");
    expect(get.queryStringParameters).toEqual({ cursor: "1" });
    expect(builtGet.queryStringParameters).toEqual({ cursor: "1" });
    expect(options).not.toHaveProperty("queryStringParameters");
    expect(builtOptions).not.toHaveProperty("queryStringParameters");
  });
});

describe("builder parity with real captures: EventBridge", () => {
  it("scheduled event keys and formats match", () => {
    const real = capture("eventbridge-scheduled");
    expect(diff("event", eventBridgeScheduledEvent, real)).toEqual(
      same("event"),
    );
    expect(real.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(eventBridgeScheduledEvent.time).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
    expect(real["detail-type"]).toBe(eventBridgeScheduledEvent["detail-type"]);
    expect(real.source).toBe("aws.events");
    expect(real.detail).toEqual({});
    expect(real.resources[0]).toMatch(/^arn:aws:events:.+:rule\/.+$/);
  });
});

describe("handler routing of real captures", () => {
  async function setup() {
    const store = new MemoryActiveStore();
    const blob = new MemoryBlobStore();
    const kv = new MemoryKV();
    const memory = new MemoryQueue();
    await bootstrapProject({
      store,
      kv,
      ids: new DeterministicIdGen(),
      orgSlug: "org",
      projectSlug: "project",
    });
    return { store, blob, kv, memory, logger: silent() };
  }
  const sqs = (eventSource: string) =>
    new SqsQueue({
      region: "us-east-1",
      environment: {
        AWS_ACCESS_KEY_ID: "fixture",
        AWS_SECRET_ACCESS_KEY: "fixture",
      },
      bindings: {},
      topics: {},
      consumers: [
        { physical: "shared", topics: ["ingest", "record"], eventSource },
      ],
      fetch: vi.fn(),
      sleep: async () => {},
      logger: { warn: vi.fn(), error: vi.fn() },
    });

  it("reports a standard SQS probe record as a batch item failure without throwing", async () => {
    const c = await setup();
    const handler = createHandler({
      roles: ["consumer"],
      http: [],
      adapters: {
        store: c.store,
        blob: c.blob,
        kv: c.kv,
        queue: sqs(STANDARD_QUEUE_ARN),
      },
      logger: c.logger,
    });
    const real = capture("sqs-standard");
    await expect(handler(real)).resolves.toEqual({
      batchItemFailures: [
        { itemIdentifier: real.Records[0].messageId as string },
      ],
    });
  });
  it("reports FIFO SQS probe records as batch item failures in order without throwing", async () => {
    const c = await setup();
    const handler = createHandler({
      roles: ["consumer"],
      http: [],
      adapters: {
        store: c.store,
        blob: c.blob,
        kv: c.kv,
        queue: sqs(FIFO_QUEUE_ARN),
      },
      logger: c.logger,
    });
    const real = capture("sqs-fifo");
    const result = (await handler(real)) as {
      batchItemFailures: { itemIdentifier: string }[];
    };
    expect(result.batchItemFailures.map((item) => item.itemIdentifier)).toEqual(
      real.Records.map((r: { messageId: string }) => r.messageId),
    );
  });

  const httpHandler = async () => {
    const c = await setup();
    return createHandler({
      roles: ["ingest"],
      http: ["ingest"],
      adapters: {
        store: c.store,
        blob: c.blob,
        kv: c.kv,
        queue: c.memory,
      },
      logger: c.logger,
    });
  };
  it("sends the function URL POST capture down the HTTP path", async () => {
    const handler = await httpHandler();
    const result = (await handler(capture("function-url-post"))) as {
      statusCode: number;
    };
    // Project 1 does not exist in this store and the key is a placeholder: a 4xx, not a crash.
    expect(result.statusCode).toBeGreaterThanOrEqual(400);
    expect(result.statusCode).toBeLessThan(500);
  });
  it("answers the OPTIONS preflight capture with 204 and leaves CORS headers to the Function URL configuration", async () => {
    const handler = await httpHandler();
    const result = (await handler(capture("function-url-options"))) as {
      statusCode: number;
      headers?: Record<string, string>;
    };
    expect(result.statusCode).toBe(204);
    expect(
      Object.keys(result.headers ?? {}).some((name) =>
        name.toLowerCase().startsWith("access-control-"),
      ),
    ).toBe(false);
  });
  it("answers the GET capture for an unknown route with 404 rather than crashing", async () => {
    const handler = await httpHandler();
    const result = (await handler(capture("function-url-get"))) as {
      statusCode: number;
    };
    expect(result.statusCode).toBe(404);
  });
  it("acknowledges the EventBridge scheduled capture as the default shape without running a job", async () => {
    const cronHandler = vi.fn(async () => {});
    const logger = silent();
    const handler = createHandler({
      roles: ["cron"],
      http: [],
      adapters: {},
      cronHandler,
      logger,
    });
    expect(await handler(capture("eventbridge-scheduled"))).toBeUndefined();
    expect(cronHandler).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(CRON_JOBS.length).toBeGreaterThan(0);
  });
});
