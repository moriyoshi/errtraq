import { PubsubQueue } from "@moriyoshi/errtraq-queue-pubsub/runtime";
import {
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@moriyoshi/errtraq-testing";
import { describe, expect, it, vi } from "vitest";
import {
  cloudRunRateLimit,
  createHandler,
  retryableInitialization,
} from "./app.js";
import { createOidcVerifier } from "./auth.js";

const project = "example-project";
const subscription = `projects/${project}/subscriptions/stack-shared`;
const eventId = "0123456789abcdef0123456789abcdef";
/** A push body as Pub/Sub sends it: a claim check whose staged envelope is not in the blob store. */
const pushBody = (extra: Record<string, unknown> = {}, sub = subscription) => ({
  message: {
    data: btoa(
      JSON.stringify({
        key: eventId,
        body: {
          projectId: "1",
          blobKey: "envelopes/1/missing",
          receivedAt: "2026-11-26T00:00:00.000Z",
        },
      }),
    ),
    attributes: { "errtraq-topic": "ingest" },
    messageId: "m-1",
    publishTime: "2026-11-26T00:00:00Z",
  },
  subscription: sub,
  ...extra,
});
const push = (body: unknown, token: string | null = "good") =>
  new Request("https://service.test/_errtraq/push/shared", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
const verify = createOidcVerifier({
  audience: "errtraq-push",
  email: "push@example-project.iam.gserviceaccount.com",
  requireEmail: true,
  verify: async (token) => {
    if (token !== "good") {
      const { GcpTokenVerificationError } = await import(
        "@moriyoshi/errtraq-gcp-auth"
      );
      throw new GcpTokenVerificationError("Invalid ID token signature");
    }
    return {} as never;
  },
});
function consumerHandler(
  overrides: Partial<Parameters<typeof createHandler>[0]> = {},
) {
  const queue = new PubsubQueue({
    projectId: project,
    region: "europe-west1",
    bindings: { SHARED: `projects/${project}/topics/stack-shared` },
    topics: { ingest: { physical: "shared", producerBinding: "SHARED" } },
    consumers: [
      { physical: "shared", eventSource: subscription, topics: ["ingest"] },
    ],
    accessToken: async () => "t",
    verifyPush: async (request) => verify(request.headers as never),
  });
  return createHandler({
    roles: ["consumer"],
    http: [],
    queuePhysicals: ["shared"],
    adapters: {
      store: new MemoryActiveStore(),
      blob: new MemoryBlobStore(),
      kv: new MemoryKV(),
      queue,
    },
    ...overrides,
  });
}
describe("Pub/Sub push route", () => {
  it("rejects a push without a valid OIDC token before decoding it", async () => {
    const handler = consumerHandler();
    expect((await handler(push(pushBody(), null))).status).toBe(401);
    expect((await handler(push(pushBody(), "forged"))).status).toBe(401);
  });
  it("nacks a missing claim until the delivery attempt reaches the floor, then acks", async () => {
    const handler = consumerHandler();
    expect((await handler(push(pushBody({ deliveryAttempt: 1 })))).status).toBe(
      503,
    );
    expect((await handler(push(pushBody({ deliveryAttempt: 5 })))).status).toBe(
      204,
    );
  });
  it("answers 400 for a subscription this function does not consume", async () => {
    const handler = consumerHandler();
    const other = `projects/${project}/subscriptions/other`;
    expect((await handler(push(pushBody({}, other)))).status).toBe(400);
  });
  it("answers 404 for a physical queue the function does not serve", async () => {
    const handler = consumerHandler();
    const response = await handler(
      new Request("https://service.test/_errtraq/push/other", {
        method: "POST",
        headers: { authorization: "Bearer good" },
        body: JSON.stringify(pushBody()),
      }),
    );
    expect(response.status).toBe(404);
  });
  it("does not expose the push route on a function without a consumer role", async () => {
    const handler = consumerHandler({ roles: ["cron"] });
    expect((await handler(push(pushBody()))).status).toBe(404);
  });
});
describe("Cloud Scheduler route", () => {
  const cron = (job: string, token = "good") =>
    new Request(`https://service.test/_errtraq/cron/${job}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  const make = (cronHandler = vi.fn(async () => {}), allowed = true) => ({
    cronHandler,
    handler: createHandler({
      roles: ["cron"],
      http: [],
      verifyCron: async (headers) =>
        allowed && headers.get("authorization") === "Bearer good",
      cronHandler,
      adapters: {},
    }),
  });
  it("runs a hosted job for an authenticated scheduler call", async () => {
    const { handler, cronHandler } = make();
    expect((await handler(cron("staged-recovery"))).status).toBe(204);
    expect(cronHandler).toHaveBeenCalledWith(
      "staged-recovery",
      expect.stringMatching(/^\d{4}-/),
    );
  });
  it("rejects unauthenticated calls and unknown jobs without running anything", async () => {
    const { handler, cronHandler } = make();
    expect((await handler(cron("staged-recovery", "forged"))).status).toBe(401);
    expect((await handler(cron("no-such-job"))).status).toBe(404);
    // Jobs of the archive role are not hosted here.
    expect((await handler(cron("archive-planner"))).status).toBe(404);
    expect(cronHandler).not.toHaveBeenCalled();
    const closed = make(undefined, false);
    expect((await closed.handler(cron("staged-recovery"))).status).toBe(401);
  });
  it("answers 500 when the job fails so Scheduler retries", async () => {
    const { handler } = make(
      vi.fn(async () => {
        throw new Error("boom with details");
      }),
    );
    const response = await handler(cron("bundle-cleanup"));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });
});
describe("other routes", () => {
  it("serves health and the public Sentry-compatible routes without internal auth", async () => {
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
    const health = await handler(
      new Request("https://service.test/_errtraq/health"),
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const envelope = await handler(
      new Request("https://service.test/api/1/envelope/", { method: "POST" }),
    );
    expect(envelope.status).toBe(401);
    // Internal routes are absent where the role is not hosted.
    expect(
      (
        await handler(
          new Request("https://service.test/_errtraq/bootstrap", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(404);
  });
  it("gates the bootstrap route behind the operator verifier", async () => {
    const bootstrap = vi.fn(async () => ({ ok: true }));
    const handler = createHandler({
      roles: ["bootstrap"],
      http: [],
      adapters: {},
      bootstrap,
      verifyOperator: async (headers) =>
        headers.get("authorization") === "Bearer operator",
    });
    const call = (token?: string, body = "{}") =>
      handler(
        new Request("https://service.test/_errtraq/bootstrap", {
          method: "POST",
          headers: token ? { authorization: `Bearer ${token}` } : {},
          body,
        }),
      );
    expect((await call()).status).toBe(401);
    expect((await call("forged")).status).toBe(401);
    expect((await call("operator", "not json")).status).toBe(400);
    expect(bootstrap).not.toHaveBeenCalled();
    const ok = await call("operator", '{"version":1}');
    expect(ok.status).toBe(200);
    expect(bootstrap).toHaveBeenCalledWith({ version: 1 });
  });
  it("refuses the archive role until the GCP archive tier exists", () => {
    expect(() =>
      createHandler({ roles: ["archive"], http: [], adapters: {} }),
    ).toThrow("not supported on Cloud Run");
  });
  it("fails closed when HTTP adapters are missing", () => {
    expect(() =>
      createHandler({ roles: ["ingest"], http: ["ingest"], adapters: {} }),
    ).toThrow("Ingest adapters are missing");
  });
  it("parses the delivered rate limit and retries a failed initialization", async () => {
    expect(cloudRunRateLimit(undefined)).toBeUndefined();
    expect(cloudRunRateLimit("disabled")).toBeNull();
    expect(cloudRunRateLimit("30")).toBe(30);
    expect(() => cloudRunRateLimit("0")).toThrow();
    let attempts = 0;
    const get = retryableInitialization(async () => {
      if (++attempts === 1) throw new Error("temporary");
      return attempts;
    });
    await expect(get()).rejects.toThrow("temporary");
    expect(await get()).toBe(2);
    expect(await get()).toBe(2);
  });
});
