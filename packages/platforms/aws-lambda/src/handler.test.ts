import {
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@errtraq/testing";
import { expect, it, vi } from "vitest";
import { createHandler } from "./handler.js";

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
it("dispatches cron jobs to the injected CronHandler and rejects missing handlers", async () => {
  const cronHandler = vi.fn(async () => {});
  const handler = createHandler({
    roles: ["cron"],
    http: [],
    adapters: {},
    cronHandler,
  });
  await handler({ job: "retention" });
  expect(cronHandler).toHaveBeenCalledWith("retention", expect.any(String));
  await expect(
    createHandler({ roles: ["cron"], http: [], adapters: {} })({
      job: "retention",
    }),
  ).rejects.toThrow("Cron handler is unavailable");
});
