import {
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@errtraq/testing";
import { expect, it, vi } from "vitest";
import {
  createHandler,
  lambdaRateLimit,
  retryableInitialization,
} from "./handler.js";

it("retries failed initialization and shares an in-flight success", async () => {
  let attempts = 0;
  const get = retryableInitialization(async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary");
    await Promise.resolve();
    return { ready: true };
  });
  await expect(get()).rejects.toThrow("temporary");
  const first = get();
  const second = get();
  expect(first).toBe(second);
  expect(await Promise.all([first, second])).toEqual([
    { ready: true },
    { ready: true },
  ]);
  expect(await get()).toEqual({ ready: true });
  expect(attempts).toBe(2);
});

it("routes Lambda URL requests through the configured Hono apps", async () => {
  const handler = createHandler({
    roles: ["ingest", "api"],
    http: ["ingest", "api"],
    adapters: {
      store: new MemoryActiveStore(),
      blob: new MemoryBlobStore(),
      queue: new MemoryQueue(),
      kv: new MemoryKV(),
    },
  });
  const result = await handler({
    version: "2.0",
    routeKey: "$default",
    rawPath: "/api/1/envelope/",
    rawQueryString: "",
    headers: { host: "example.test" },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      http: {
        method: "OPTIONS",
        path: "/api/1/envelope/",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      domainName: "example.test",
      requestId: "test",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      accountId: "",
      apiId: "",
    },
  });
  expect(result).toMatchObject({
    statusCode: 204,
    headers: { "access-control-allow-origin": "*" },
  });
});
it("delegates SQS to the queue push source with the consumer handler", async () => {
  const memory = new MemoryQueue();
  const push = vi.fn(
    async (
      _event: unknown,
      handler: NonNullable<typeof memory.push>["handle"] extends (
        event: unknown,
        handler: infer H,
      ) => unknown
        ? H
        : never,
    ) => {
      await handler([]);
      return { batchItemFailures: [] };
    },
  );
  const handler = createHandler({
    roles: ["consumer"],
    http: [],
    adapters: {
      store: new MemoryActiveStore(),
      blob: new MemoryBlobStore(),
      queue: {
        ...memory,
        producer: memory.producer,
        capabilities: memory.capabilities,
        push: { handle: push },
      },
    },
  });
  const event = { Records: [] };
  expect(await handler(event)).toEqual({ batchItemFailures: [] });
  expect(push).toHaveBeenCalledWith(event, expect.any(Function));
});
it("routes record deliveries to the record handler in grouped mode", async () => {
  const memory = new MemoryQueue();
  const push = vi.fn(
    async (_event: unknown, handler: import("@errtraq/core").BatchHandler) => {
      const results = await handler([
        {
          id: "poison",
          topic: "record",
          attempt: 1,
          message: { key: "bad", groupKey: "issue", body: {} },
        },
      ]);
      return {
        batchItemFailures: results
          .filter((result) => result.action === "retry")
          .map((result) => ({ itemIdentifier: result.deliveryId })),
      };
    },
  );
  const handler = createHandler({
    roles: ["record"],
    recordMode: "grouped",
    http: [],
    adapters: {
      store: new MemoryActiveStore(),
      blob: new MemoryBlobStore(),
      queue: {
        ...memory,
        producer: memory.producer,
        capabilities: memory.capabilities,
        push: { handle: push },
      },
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  expect(await handler({ Records: [] })).toEqual({
    batchItemFailures: [{ itemIdentifier: "poison" }],
  });
  expect(push).toHaveBeenCalledOnce();
});
it("does not add ingest CORS to API routes when roles are combined", async () => {
  const adapters = {
    store: new MemoryActiveStore(),
    blob: new MemoryBlobStore(),
    queue: new MemoryQueue(),
    kv: new MemoryKV(),
  };
  const event = {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/api/0/issues/123",
    rawQueryString: "",
    headers: { host: "example.test" },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      http: {
        method: "GET",
        path: "/api/0/issues/123",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      domainName: "example.test",
      requestId: "test",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      accountId: "",
      apiId: "",
    },
  };
  const combinedHandler = createHandler({
    roles: ["ingest", "api"],
    http: ["ingest", "api"],
    adapters,
  });
  const apiHandler = createHandler({
    roles: ["api"],
    http: ["api"],
    adapters,
  });
  for (const method of ["GET", "OPTIONS"]) {
    event.requestContext.http.method = method;
    const combined = await combinedHandler(event);
    const apiOnly = await apiHandler(event);
    expect(combined).toEqual(apiOnly);
    expect(combined).not.toHaveProperty("headers.access-control-allow-origin");
  }
});
it("dispatches known cron jobs and acknowledges unknown or missing jobs", async () => {
  const cronHandler = vi.fn(async () => {});
  const handler = createHandler({
    roles: ["cron"],
    http: [],
    adapters: {},
    cronHandler,
  });
  await handler({ job: "retention" });
  expect(cronHandler).toHaveBeenCalledWith("retention", expect.any(String));
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const fallback = createHandler({
    roles: ["cron"],
    http: [],
    adapters: {},
    logger,
  });
  await expect(fallback({ job: "retention" })).resolves.toBeUndefined();
  expect(logger.warn).toHaveBeenCalledWith("Cron job not implemented", {
    job: "retention",
  });
  await expect(fallback({ job: "unknown" })).resolves.toBeUndefined();
  await expect(fallback({})).resolves.toBeUndefined();
  await expect(fallback(null)).resolves.toBeUndefined();
  await expect(fallback("invalid")).resolves.toBeUndefined();
  expect(logger.error).toHaveBeenCalledTimes(4);
});

it("executes staged-envelope recovery through its delivered blob and queue adapters", async () => {
  const blobs = new MemoryBlobStore();
  const queue = new MemoryQueue();
  const send = vi.spyOn(queue.producer, "send");
  const key =
    "envelopes/1/2020-01-01T00%3A00%3A00.000Z/00000000000000000000000000000001";
  await blobs.put(key, new TextEncoder().encode("staged"));
  const handler = createHandler({
    roles: ["cron"],
    http: [],
    adapters: { blob: blobs, queue },
  });
  await handler({ job: "staged-recovery" });
  expect(send).toHaveBeenCalledWith("ingest", [
    expect.objectContaining({
      body: expect.objectContaining({ blobKey: key, recovered: true }),
    }),
  ]);
});

it("enforces the configured limit independently for each DSN key and can disable it", async () => {
  const store = new MemoryActiveStore();
  vi.spyOn(store.projects, "getKey").mockImplementation(async (key) => ({
    id: key as import("@errtraq/core").ProjectKeyId,
    publicKey: key,
    projectId: "1" as import("@errtraq/core").ProjectId,
  }));
  const adapters = {
    store,
    blob: new MemoryBlobStore(),
    queue: new MemoryQueue(),
    kv: new MemoryKV(),
  };
  const make = (rateLimit: number | null) =>
    createHandler({ roles: ["ingest"], http: ["ingest"], adapters, rateLimit });
  const event = (key: string) => ({
    version: "2.0",
    routeKey: "$default",
    rawPath: "/api/1/envelope/",
    rawQueryString: `sentry_key=${key}`,
    headers: {
      host: "example.test",
      "content-type": "application/x-sentry-envelope",
    },
    body: '{}\n{"type":"event"}\n{"message":"test"}\n',
    isBase64Encoded: false,
    requestContext: {
      http: {
        method: "POST",
        path: "/api/1/envelope/",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "test",
      },
      domainName: "example.test",
      requestId: "test",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      accountId: "",
      apiId: "",
    },
  });
  const limited = make(lambdaRateLimit("1") ?? 1);
  expect(await limited(event("first"))).toMatchObject({ statusCode: 200 });
  expect(await limited(event("first"))).toMatchObject({ statusCode: 429 });
  expect(await limited(event("second"))).toMatchObject({ statusCode: 200 });
  const disabled = make(lambdaRateLimit("disabled") ?? null);
  expect(await disabled(event("first"))).toMatchObject({ statusCode: 200 });
  expect(await disabled(event("first"))).toMatchObject({ statusCode: 200 });
  expect(lambdaRateLimit(undefined)).toBeUndefined();
  for (const invalid of ["0", "1.5", "-1", "NaN", "9007199254740992"])
    expect(() => lambdaRateLimit(invalid)).toThrow(
      "Invalid Lambda ingest rate limit",
    );
});

it("accepts rate-rejection configuration for an idle handler", () => {
  expect(() =>
    createHandler({
      roles: [],
      http: [],
      adapters: {},
      rateRejection: { issueRateLimit: { events: 1, windowSec: 60 } },
    }),
  ).not.toThrow();
});
