import {
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@errtraq/testing";
import { expect, it, vi } from "vitest";
import { createHandler, retryableInitialization } from "./handler.js";

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
