import { describe, expect, it } from "vitest";
import { create, PubsubQueue } from "./runtime.js";
import { configSchema, infra, manifest, pubsubQueue } from "./stack.js";

const valid = { projectId: "my-project-1", region: "asia-northeast1" };
const view = {
  triggers: [
    { kind: "queue", physical: "shared" },
    { kind: "queue", physical: "record" },
  ],
} as never;

describe("config", () => {
  it("requires projectId and region and never defaults them", () => {
    expect(configSchema.safeParse({}).success).toBe(false);
    expect(configSchema.safeParse({ projectId: "my-project-1" }).success).toBe(
      false,
    );
    expect(configSchema.safeParse({ region: "asia-northeast1" }).success).toBe(
      false,
    );
    expect(configSchema.parse(valid)).toMatchObject({
      mode: "shared",
      pushAuth: "verifier",
      dlq: true,
      maxDeliveryAttempts: 5,
    });
  });
  it.each([
    { maxDeliveryAttempts: 4 },
    { maxDeliveryAttempts: 101 },
    { ackDeadlineSec: 9 },
    { ackDeadlineSec: 601 },
    { minBackoffSec: 20, maxBackoffSec: 10 },
    { pushAuth: "maybe" },
    { unknown: 1 },
  ])("rejects %j", (extra) => {
    expect(configSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
  });
});

describe("manifest and descriptor", () => {
  it("declares truthful capabilities", () => {
    expect(manifest.capabilities).toMatchObject({
      delivery: "push",
      delay: false,
      dlq: true,
      grouping: "per-key-serial",
    });
  });
  it("snapshots the module inputs for shared mode", () => {
    const selection = pubsubQueue(valid);
    expect(selection.infra.module).toMatchObject({
      provider: "google",
      component: "pubsub",
    });
    expect(
      selection.infra.inputs(selection.config as never, view),
    ).toMatchInlineSnapshot(`
      {
        "name": {
          "name": "name",
          Symbol(@moriyoshi/errtraq-infra-reference): "stack",
        },
        "physical_queues": {
          "record": {
            "ack_deadline_sec": 180,
            "dlq_enabled": true,
            "max_backoff_sec": 600,
            "max_delivery_attempts": 5,
            "min_backoff_sec": 10,
            "ordered": true,
          },
          "shared": {
            "ack_deadline_sec": 180,
            "dlq_enabled": true,
            "max_backoff_sec": 600,
            "max_delivery_attempts": 5,
            "min_backoff_sec": 10,
            "ordered": false,
          },
        },
        "project_id": "my-project-1",
        "region": "asia-northeast1",
      }
    `);
    expect(selection.infra.bindings.map((b) => b.name)).toEqual([
      "ERRTRAQ_QUEUE_SHARED_TOPIC",
      "ERRTRAQ_QUEUE_RECORD_TOPIC",
    ]);
    expect(selection.infra.topics?.routes.record).toMatchObject({
      physical: "record",
      grouping: "per-key-serial",
    });
    expect(selection.infra.topics?.settings?.record).toEqual({
      visibilityTimeoutSec: 180,
      retryBackoffSec: { min: 10, max: 600 },
      dlq: { enabled: true, maxReceiveCount: 5 },
    });
  });
  it("per-topic mode splits physical queues", () => {
    const selection = pubsubQueue({ ...valid, mode: "per-topic", dlq: false });
    expect(Object.keys(selection.infra.resources).sort()).toEqual([
      "archive_project",
      "ingest",
      "notifications",
      "record",
    ]);
    expect(selection.infra.topics?.settings?.ingest?.dlq).toEqual({
      enabled: false,
    });
    expect(selection.infra.topics?.settings?.record?.dlq?.enabled).toBe(true);
  });
  it("has a default descriptor", () => {
    expect(infra.module.component).toBe("pubsub");
  });
});

describe("create", () => {
  const context = (config: object, dependencies: object = {}, extra = {}) =>
    ({
      config: configSchema.parse({ ...valid, ...config }),
      bindings: {},
      dependencies,
      ...extra,
    }) as never;
  it("builds a producer-only queue with an injected token source", () => {
    expect(
      create(context({}, { accessToken: async () => "t" })),
    ).toBeInstanceOf(PubsubQueue);
  });
  it("needs a verifier for consumers unless pushAuth is explicitly relaxed", () => {
    const consumers = {
      queueConsumers: [
        {
          eventSource: "projects/p/subscriptions/s",
          physical: "shared",
          topics: ["ingest"],
        },
      ],
    };
    const dependencies = { accessToken: async () => "t" };
    expect(() => create(context({}, dependencies, consumers))).toThrow(
      /verifyPush/,
    );
    expect(
      create(
        context(
          {},
          { ...dependencies, verifyPush: async () => true },
          consumers,
        ),
      ),
    ).toBeInstanceOf(PubsubQueue);
    expect(
      create(context({ pushAuth: "platform" }, dependencies, consumers)),
    ).toBeInstanceOf(PubsubQueue);
  });
  it("uses PUBSUB_EMULATOR_HOST without credentials", () => {
    expect(
      create(
        context(
          {},
          {},
          { environment: { PUBSUB_EMULATOR_HOST: "127.0.0.1:8085" } },
        ),
      ),
    ).toBeInstanceOf(PubsubQueue);
  });
  describe("pushAuth none (test switch)", () => {
    const emulator = { PUBSUB_EMULATOR_HOST: "127.0.0.1:8085" };
    it("works against a loopback emulator", () => {
      expect(
        create(context({ pushAuth: "none" }, {}, { environment: emulator })),
      ).toBeInstanceOf(PubsubQueue);
      expect(
        create(
          context(
            { pushAuth: "none", endpoint: "http://127.0.0.1:8085" },
            {},
            { environment: {} },
          ),
        ),
      ).toBeInstanceOf(PubsubQueue);
    });
    it("is refused without a loopback emulator", () => {
      expect(() =>
        create(context({ pushAuth: "none" }, { accessToken: async () => "t" })),
      ).toThrow("loopback");
      expect(() =>
        create(
          context(
            { pushAuth: "none" },
            {},
            { environment: { PUBSUB_EMULATOR_HOST: "pubsub.example:8085" } },
          ),
        ),
      ).toThrow("loopback");
    });
    it("is refused on Cloud Run even with an emulator host", () => {
      expect(() =>
        create(
          context(
            { pushAuth: "none" },
            {},
            { environment: { ...emulator, K_SERVICE: "ingest" } },
          ),
        ),
      ).toThrow("not allowed on Cloud Run");
    });
    it("is rejected by the schema with a non-loopback endpoint", () => {
      expect(
        configSchema.safeParse({
          ...valid,
          pushAuth: "none",
          endpoint: "https://pubsub.googleapis.com",
        }).success,
      ).toBe(false);
    });
  });
});
