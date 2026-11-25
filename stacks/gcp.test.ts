import type { ResolvedStack, StackConfig } from "@moriyoshi/errtraq-core";
import { cloudRun } from "@moriyoshi/errtraq-platform-cloud-run/stack";
import { memoryQueue } from "@moriyoshi/errtraq-queue-memory/stack";
import { pubsubQueue } from "@moriyoshi/errtraq-queue-pubsub/stack";
import { afterEach, describe, expect, it, vi } from "vitest";

const env = {
  ERRTRAQ_GCP_PROJECT: "example-project",
  ERRTRAQ_GCP_REGION: "europe-west1",
  ERRTRAQ_GCP_SQL_INSTANCE: "example-sql",
};
const stacks = {
  "gcp-firestore": () => import("./gcp-firestore.js"),
  "gcp-cloudsql": () => import("./gcp-cloudsql.js"),
};
/** A fresh module graph, so the stack file reads the environment this test set. */
async function fresh(name: keyof typeof stacks) {
  vi.resetModules();
  const core = await import("@moriyoshi/errtraq-core");
  const { generate } = await import("../packages/infra-gen/src/index.js");
  return {
    core,
    deriveDeployment: core.deriveDeployment,
    generate,
    stack: (await stacks[name]()).default as ResolvedStack,
  };
}
afterEach(() => vi.unstubAllEnvs());
const options = {
  outputDirectory: "infra/generated/example",
  modulesDirectory: "infra/modules",
  generationEnv: {},
  artifactPaths: {},
};
describe.each(["gcp-firestore", "gcp-cloudsql"] as const)("%s", (name) => {
  it("validates and defaults to grouped recording on Pub/Sub", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    // defineStack validates and resolves: importing the stack is the validation.
    const { stack, deriveDeployment } = await fresh(name);
    expect(stack.recordMode).toBe("grouped");
    const view = deriveDeployment(stack);
    expect(view.functions.map((fn) => fn.id).sort()).toEqual([
      "api",
      "consumer",
      "cron",
      "ingest",
      "record",
    ]);
    // The push subscription name reaches the consumer function as its event-source binding.
    const names = (id: string) =>
      view.functions
        .find((fn) => fn.id === id)
        ?.envBindings.map((item) => item.binding.name);
    expect(names("consumer")).toContain("ERRTRAQ_QUEUE_SOURCE_SHARED");
    expect(names("record")).toContain("ERRTRAQ_QUEUE_SOURCE_RECORD");
    // Scheduler jobs are exactly the ones the Cloud Run handler hosts without an archive.
    expect(
      view.triggers
        .flatMap((trigger) => (trigger.kind === "cron" ? [trigger.name] : []))
        .sort(),
    ).toEqual(["bundle-cleanup", "staged-recovery"]);
  });
  it("generates Terraform for the google provider", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { stack, generate } = await fresh(name);
    const result = generate(stack, options);
    if (result.kind !== "terraform") throw new Error("expected terraform");
    expect(result.files["providers.tf.json"]).toMatchSnapshot("providers");
    expect(result.files["main.tf.json"]).toMatchSnapshot("main");
    const providers = JSON.parse(result.files["providers.tf.json"] ?? "{}");
    expect(providers.provider.google).toEqual([
      {
        project: "example-project",
        region: "europe-west1",
        default_labels: { app: "errtraq" },
      },
    ]);
    expect(providers.terraform.required_providers.google.version).toContain(
      ">= 8.0.0, < 9.0",
    );
  });
  it("refuses to run without a project and region", async () => {
    vi.stubEnv("ERRTRAQ_GCP_PROJECT", "");
    vi.stubEnv("ERRTRAQ_GCP_REGION", "");
    vi.stubEnv("ERRTRAQ_GCP_SQL_INSTANCE", "x");
    await expect(fresh(name)).rejects.toThrow(/no default/);
  });
});

/** Messages of the issues validation reports for a variant of the Firestore example. */
async function issues(change: (stack: StackConfig) => Partial<StackConfig>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { stack, core } = await fresh("gcp-firestore");
  const base = Object.fromEntries(Object.entries(stack)) as StackConfig;
  return core
    .validateStack({ ...base, ...change(base) })
    .map((issue) => `${issue.path}: ${issue.message}`);
}

import {
  createGcpRuntimeAuth,
  createHandler,
  createOidcVerifier,
  gcpHostBindings,
} from "@moriyoshi/errtraq-platform-cloud-run/handler";

const project = "example-project";
const region = "europe-west1";
const image = `registry.example/errtraq/app@sha256:${"a".repeat(64)}`;
const platform = (extra: Record<string, unknown> = {}) =>
  cloudRun({
    projectId: project,
    region,
    image,
    roles: ["ingest", "api", "consumer", "record", "cron"],
    split: ["ingest", "api", "consumer", "record", "cron"],
    ...extra,
  } as never);
describe("GCP stack validation", () => {
  it("accepts the unmodified variant", async () => {
    expect(await issues(() => ({}))).toEqual([]);
  });
  it("requires a project and a region on the google provider", async () => {
    const found = await issues(
      (base) =>
        ({
          providers: {
            google: { ...base.providers?.google, project: undefined },
          },
        }) as never,
    );
    expect(found.join("\n")).toContain(
      "Project is required for the Google provider",
    );
    const noRegion = await issues(
      (base) =>
        ({
          providers: {
            google: { ...base.providers?.google, region: undefined },
          },
        }) as never,
    );
    expect(noRegion.join("\n")).toContain(
      "Region is required for the Google provider",
    );
  });
  it("rejects an archive on Cloud Run until the GCP archive tier exists", async () => {
    const { default: aws } = await import("./aws-dynamodb-archive.js");
    const found = await issues(() => ({ archive: aws.archive }));
    expect(found.join("\n")).toContain(
      "Platform cloud-run does not support an archive yet",
    );
  });
  it("rejects an ack deadline below six consumer timeouts", async () => {
    const found = await issues(() => ({
      queue: pubsubQueue({ projectId: project, region, ackDeadlineSec: 100 }),
      platform: platform({
        settings: { consumer: { timeoutSec: 30 }, record: { timeoutSec: 30 } },
      }),
    }));
    expect(found.join("\n")).toContain(
      "at least six times the consumer timeout",
    );
  });
  it("states the ack deadline maximum when the consumer timeout cannot fit", async () => {
    const found = await issues(() => ({
      queue: pubsubQueue({ projectId: project, region, ackDeadlineSec: 600 }),
      platform: platform({
        settings: { consumer: { timeoutSec: 200 }, record: { timeoutSec: 30 } },
      }),
    }));
    expect(found.join("\n")).toContain("cannot exceed 600 seconds");
    expect(found.join("\n")).toContain("at most 100 seconds");
    const fits = await issues(() => ({
      queue: pubsubQueue({ projectId: project, region, ackDeadlineSec: 600 }),
      platform: platform({
        settings: { consumer: { timeoutSec: 100 }, record: { timeoutSec: 30 } },
      }),
    }));
    expect(fits).toEqual([]);
  });
  it("enforces the platform dead-letter attempt floor", async () => {
    const found = await issues(() => {
      const queue = pubsubQueue({ projectId: project, region });
      const settings = queue.infra.topics?.settings;
      if (settings?.shared)
        settings.shared = {
          ...settings.shared,
          dlq: { enabled: true, maxReceiveCount: 3 },
        };
      return { queue };
    });
    expect(found.join("\n")).toContain(
      "maxReceiveCount on platform cloud-run must be at least 5",
    );
  });
  it("rejects a topic mapping that contradicts the Pub/Sub mode", async () => {
    const found = await issues(() => {
      const queue = pubsubQueue({ projectId: project, region, mode: "shared" });
      const routes = queue.infra.topics?.routes;
      if (routes)
        routes.notifications = {
          ...routes.notifications,
          physical: "notifications",
        };
      return { queue };
    });
    expect(found.join("\n")).toContain(
      "Shared topics must use the same physical queue",
    );
  });
  it("requires ordered delivery on the record queue", async () => {
    const found = await issues(() => {
      const queue = pubsubQueue({ projectId: project, region });
      const record = queue.infra.topics?.routes.record;
      if (queue.infra.topics && record)
        queue.infra.topics.routes.record = {
          physical: record.physical,
          producerBinding: record.producerBinding,
        };
      return { queue };
    });
    expect(found.join("\n")).toContain(
      "Grouped recording requires per-key serial delivery",
    );
  });
  it("still rejects a pull-only queue on a function platform", async () => {
    const found = await issues(() => ({ queue: memoryQueue() as never }));
    expect(found.join("\n")).toMatch(
      /Pull-only queues require long-lived compute/,
    );
  });
  it("lists ambient credentials as a platform feature the Cloud SQL store needs", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { stack, core } = await fresh("gcp-cloudsql");
    const { default: aws } = await import("./aws-dynamodb.js");
    const found = core
      .validateStack({
        ...(Object.fromEntries(Object.entries(stack)) as StackConfig),
        platform: aws.platform,
      })
      .map((issue) => issue.message);
    expect(found).toContain("Platform does not provide ambient-credentials");
  });
  it("rejects labels Google would refuse", async () => {
    const found = await issues(
      (base) =>
        ({
          providers: {
            google: { ...base.providers?.google, tags: { App: "errtraq" } },
          },
        }) as never,
    );
    expect(found.join("\n")).toContain("Google labels need lowercase");
  });
});
describe("subscription to consumer mapping", () => {
  it("delivers the reserved subscription name as the event source and routes a push to it", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { stack, core } = await fresh("gcp-firestore");
    const plan = core.deployedPlan(stack, "consumer");
    expect(plan.queueConsumers).toEqual([
      {
        physical: "shared",
        topics: ["ingest"],
        eventSourceBinding: "ERRTRAQ_QUEUE_SOURCE_SHARED",
      },
    ]);
    const subscription = `projects/${project}/subscriptions/gcp-firestore-shared`;
    const environment: Record<string, string> = {
      ERRTRAQ_BLOB_BUCKET: "bucket",
      ERRTRAQ_STORE_DATABASE: "store",
      ERRTRAQ_KV_DATABASE: "kv",
      ERRTRAQ_QUEUE_SHARED_TOPIC: `projects/${project}/topics/gcp-firestore-shared`,
      ERRTRAQ_QUEUE_RECORD_TOPIC: `projects/${project}/topics/gcp-firestore-record`,
      ERRTRAQ_QUEUE_SOURCE_SHARED: subscription,
      // Never reached: the construction below must not call the network.
      GCE_METADATA_HOST: "127.0.0.1:1",
    };
    const auth = createGcpRuntimeAuth(environment);
    const verifyPush = createOidcVerifier({
      audience: "errtraq-push",
      email: "push@example-project.iam.gserviceaccount.com",
      requireEmail: true,
      verify: async () => ({}) as never,
    });
    const built = await core.constructDeployedPlan(
      plan,
      environment,
      (name) => import(/* @vite-ignore */ name),
      undefined,
      undefined,
      gcpHostBindings(auth, (request) => verifyPush(request.headers as never)),
    );
    try {
      const adapters = Object.fromEntries(
        plan.selections
          .filter((item) => !item.path.includes("."))
          .map((item) => [item.kind, built.instances.get(item.path)]),
      );
      const handler = createHandler({
        roles: ["consumer"],
        http: [],
        recordMode: "grouped",
        queuePhysicals: ["shared"],
        adapters: adapters as never,
      });
      const body = (sub: string) =>
        JSON.stringify({
          message: {
            data: btoa(
              JSON.stringify({
                key: "0123456789abcdef0123456789abcdef",
                body: {
                  projectId: "1",
                  blobKey: "envelopes/1/x",
                  receivedAt: "2026-11-26T00:00:00.000Z",
                },
              }),
            ),
            attributes: { "errtraq-topic": "ingest" },
            messageId: "m1",
            publishTime: "2026-11-26T00:00:00Z",
          },
          subscription: sub,
          deliveryAttempt: 1,
        });
      const push = (sub: string) =>
        handler(
          new Request("https://service.test/_errtraq/push/shared", {
            method: "POST",
            headers: { authorization: "Bearer a.b.c" },
            body: body(sub),
          }),
        );
      // The delivered name is the one the queue adapter maps to the consumer; others are invalid.
      expect((await push(subscription)).status).not.toBe(400);
      expect((await push(`${subscription}-other`)).status).toBe(400);
    } finally {
      await built.close();
    }
  });
});
