import {
  type ApiTokenId,
  bootstrapProject,
  hashApiToken,
  type Message,
} from "@moriyoshi/errtraq-core";
import {
  DeterministicIdGen,
  FakeClock,
  MemoryActiveStore,
  MemoryArchiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@moriyoshi/errtraq-testing";
import { expect, it, vi } from "vitest";
import {
  createHandler,
  lambdaIngestUrl,
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
  const event = {
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
  };
  const result = await handler(event);
  expect(result).toMatchObject({ statusCode: 204 });
  expect(result).not.toHaveProperty("headers.access-control-allow-origin");
  expect(result).not.toHaveProperty("headers.access-control-allow-methods");
  const post = await handler({
    ...event,
    requestContext: {
      ...event.requestContext,
      http: { ...event.requestContext.http, method: "POST" },
    },
  });
  expect(post).toMatchObject({ statusCode: 401 });
  expect(post).not.toHaveProperty("headers.access-control-allow-origin");
  expect(post).not.toHaveProperty("headers.access-control-expose-headers");
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
    async (
      _event: unknown,
      handler: import("@moriyoshi/errtraq-core").BatchHandler,
    ) => {
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

it("runs bundle-cleanup through the store and blob adapters of the cron role", async () => {
  const store = new MemoryActiveStore();
  const list = vi.spyOn(store.projects, "list");
  const handler = createHandler({
    roles: ["cron"],
    http: [],
    adapters: { store, blob: new MemoryBlobStore() },
  });
  await handler({ job: "bundle-cleanup" });
  expect(list).toHaveBeenCalledTimes(1);
  const bare = createHandler({ roles: ["cron"], http: [], adapters: {} });
  await expect(bare({ job: "bundle-cleanup" })).rejects.toThrow(
    "Bundle cleanup adapters are missing",
  );
});

it("enforces the configured limit independently for each DSN key and can disable it", async () => {
  const store = new MemoryActiveStore();
  vi.spyOn(store.projects, "getKey").mockImplementation(async (key) => ({
    id: key as import("@moriyoshi/errtraq-core").ProjectKeyId,
    publicKey: key,
    projectId: "1" as import("@moriyoshi/errtraq-core").ProjectId,
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

it("wires KV and rate rejection to the API role only when configured", () => {
  const adapters = {
    store: new MemoryActiveStore(),
    blob: new MemoryBlobStore(),
  };
  const options = {
    roles: ["api"] as const,
    http: ["api"] as const,
    adapters,
    rateRejection: { newIssueCap: { issues: 1, windowSec: 60 } },
  };
  expect(() => createHandler(options)).toThrow(
    "Rate rejection API requires KV",
  );
  expect(() =>
    createHandler({
      ...options,
      adapters: { ...adapters, kv: new MemoryKV() },
    }),
  ).not.toThrow();
  expect(() =>
    createHandler({ ...options, rateRejection: undefined }),
  ).not.toThrow();
});

/** Run one ingest claim of three events through a grouped consumer-only handler. */
async function groupedConsumerRun(
  rateRejection: import("@moriyoshi/errtraq-core").RateRejectionConfig,
  options: { withStore: boolean; issueEvents?: number },
) {
  const clock = new FakeClock();
  const store = new MemoryActiveStore();
  const kv = new MemoryKV(clock);
  const blobs = new MemoryBlobStore();
  const { project } = await bootstrapProject({
    store,
    kv,
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "web",
  });
  if (options.issueEvents)
    await store.projects.put({
      ...project,
      rateLimits: { issueEvents: options.issueEvents },
    });
  const read = vi.spyOn(store.projects, "get");
  const write = vi.spyOn(store, "recordEvent");
  const sent: Message[] = [];
  const memory = new MemoryQueue();
  const text = `{}\n${[1, 2, 3]
    .map(
      (n) =>
        `{"type":"event"}\n${JSON.stringify({ event_id: n.toString(16).padStart(32, "0"), message: "x" })}\n`,
    )
    .join("")}`;
  const bytes = new TextEncoder().encode(text);
  await blobs.put("envelopes/one", bytes, { size: bytes.length });
  const queue = {
    ...memory,
    capabilities: memory.capabilities,
    producer: {
      send: async (_topic: string, messages: Message[]) => {
        sent.push(...messages);
      },
    },
    push: {
      handle: async (
        _event: unknown,
        handler: import("@moriyoshi/errtraq-core").BatchHandler,
      ) => {
        await handler([
          {
            id: "d1",
            topic: "ingest",
            attempt: 1,
            message: {
              key: "1".padStart(32, "0"),
              body: {
                projectId: project.id,
                blobKey: "envelopes/one",
                receivedAt: clock.now(),
              },
            },
          },
        ]);
        return {};
      },
    },
  } as unknown as import("@moriyoshi/errtraq-core").Queue;
  const handler = createHandler({
    roles: ["consumer"],
    recordMode: "grouped",
    http: [],
    rateRejection,
    adapters: {
      ...(options.withStore ? { store } : {}),
      blob: blobs,
      queue,
      kv,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await handler({ Records: [] });
  return { sent, read, write };
}

it("gives the grouped consumer project reads only, and only for a per-issue limit", async () => {
  const issue = { issueRateLimit: { events: 3, windowSec: 60 } };
  // A project override tightens the per-issue limit; the consumer never writes the store.
  const tight = await groupedConsumerRun(issue, {
    withStore: true,
    issueEvents: 1,
  });
  expect(tight.sent).toHaveLength(1);
  expect(tight.read).toHaveBeenCalledTimes(1);
  expect(tight.write).not.toHaveBeenCalled();
  const loose = await groupedConsumerRun(issue, { withStore: true });
  expect(loose.sent).toHaveLength(3);
  // Without the per-issue limit the consumer receives no store access and reads no project.
  const capOnly = await groupedConsumerRun(
    { newIssueCap: { issues: 5, windowSec: 60 } },
    { withStore: true, issueEvents: 1 },
  );
  expect(capOnly.sent).toHaveLength(3);
  expect(capOnly.read).not.toHaveBeenCalled();
  // A missing grant must not silently ignore project overrides.
  await expect(groupedConsumerRun(issue, { withStore: false })).rejects.toThrow(
    "project read access",
  );
});

it("hosts the archive worker, the planner and housekeeping on the archive role (D6)", async () => {
  const memory = new MemoryQueue();
  const store = new MemoryActiveStore();
  const archive = new MemoryArchiveStore();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const send = vi.spyOn(memory.producer, "send");
  const push = vi.fn(
    async (
      _event: unknown,
      handler: import("@moriyoshi/errtraq-core").BatchHandler,
    ) =>
      handler([
        {
          id: "a",
          topic: "archive.project",
          attempt: 1,
          // An unknown project is acknowledged by the worker without touching the archive.
          message: { key: "k", body: { projectId: "404" } },
        },
        {
          id: "b",
          topic: "ingest",
          attempt: 1,
          message: { key: "i", body: {} },
        },
      ]),
  );
  const handler = createHandler({
    roles: ["archive"],
    http: [],
    adapters: {
      store,
      blob: new MemoryBlobStore(),
      queue: { ...memory, producer: memory.producer, push: { handle: push } },
      archive,
    },
    archiveRetentionDays: 365,
    archiveInvocationTimeoutMs: 300_000,
    logger,
  });
  // The archive role takes archive.project and never the ingest topic.
  expect(await handler({ Records: [] })).toEqual(
    expect.arrayContaining([
      { deliveryId: "a", action: "ack" },
      { deliveryId: "b", action: "retry" },
    ]),
  );
  await store.projects.putOrg({ id: "o" as never, slug: "o", name: "o" });
  await store.projects.put({
    id: "1" as never,
    orgId: "o" as never,
    slug: "p",
    name: "p",
    retentionDays: 30,
  });
  await handler({ job: "archive-planner" });
  expect(send).toHaveBeenCalledWith("archive.project", [
    expect.objectContaining({ body: { projectId: "1" } }),
  ]);
  // Housekeeping runs from the retention job on this role.
  await handler({ job: "retention" });
  expect(logger.warn).not.toHaveBeenCalledWith("Cron job not implemented", {
    job: "retention",
  });
  // Jobs of the cron role are not hosted here.
  await handler({ job: "staged-recovery" });
  expect(logger.error).toHaveBeenCalledWith("Unknown or missing cron job");
  await expect(handler("invalid")).resolves.toBeUndefined();
});

it("requires the archive adapters for the archive role and gives the API the archive for federation", () => {
  expect(() =>
    createHandler({
      roles: ["archive"],
      http: [],
      adapters: { store: new MemoryActiveStore() },
    }),
  ).toThrow("Archive adapters are missing");
  expect(() =>
    createHandler({
      roles: ["api"],
      http: ["api"],
      adapters: {
        store: new MemoryActiveStore(),
        blob: new MemoryBlobStore(),
        archive: new MemoryArchiveStore(),
      },
    }),
  ).not.toThrow();
});

it("builds DSNs from the operator-supplied ingest URL and adds no CORS headers itself", async () => {
  const store = new MemoryActiveStore();
  const clock = new FakeClock();
  const boot = await bootstrapProject({
    store,
    kv: new MemoryKV(clock),
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "web",
  });
  await store.projects.putToken({
    id: "token" as ApiTokenId,
    orgId: boot.org.id,
    tokenHash: await hashApiToken("errtraq_secret"),
    scopes: ["event:read"],
  });
  const request = (
    handler: (event: unknown) => Promise<unknown>,
    headers: Record<string, string>,
  ) =>
    handler({
      version: "2.0",
      routeKey: "$default",
      rawPath: "/api/0/projects/org/web/keys/",
      rawQueryString: "",
      headers: { host: "api.example.test", ...headers },
      body: null,
      isBase64Encoded: false,
      requestContext: {
        http: {
          method: "GET",
          path: "/api/0/projects/org/web/keys/",
          protocol: "HTTP/1.1",
          sourceIp: "127.0.0.1",
          userAgent: "test",
        },
        domainName: "api.example.test",
        requestId: "test",
        stage: "$default",
        time: "",
        timeEpoch: 0,
        accountId: "",
        apiId: "",
      },
    }) as Promise<{ statusCode: number; body: string; headers: object }>;
  const make = (ingestUrl?: string) =>
    createHandler({
      roles: ["api"],
      http: ["api"],
      ...(ingestUrl ? { ingestUrl } : {}),
      adapters: { store, blob: new MemoryBlobStore() },
    });
  const headers = {
    authorization: "Bearer errtraq_secret",
    origin: "https://ui.test",
  };
  const withUrl = await request(make("https://ingest.example.test/"), headers);
  expect(withUrl.statusCode).toBe(200);
  expect(JSON.parse(withUrl.body)[0].dsn.public).toBe(
    `https://${boot.key.publicKey}@ingest.example.test/${boot.project.id}`,
  );
  // The function URL's CORS block carries the browser policy; the app must not duplicate it.
  expect(withUrl.headers).not.toHaveProperty("access-control-allow-origin");
  const without = await request(make(), headers);
  expect(JSON.parse(without.body)[0]).not.toHaveProperty("dsn");
});
it("validates the delivered public ingest URL", () => {
  expect(lambdaIngestUrl(undefined)).toBeUndefined();
  expect(lambdaIngestUrl("")).toBeUndefined();
  expect(lambdaIngestUrl("https://ingest.example.test")).toBe(
    "https://ingest.example.test",
  );
  for (const invalid of ["ingest.example.test", "ftp://x.test", "https://"])
    expect(() => lambdaIngestUrl(invalid)).toThrow("Invalid public ingest URL");
});
