import * as blobModule from "@errtraq/blob-s3";
import { s3Blob } from "@errtraq/blob-s3/stack";
import {
  artifact,
  configReference,
  deriveDeployment,
  env,
  out,
  output,
  resolveStack,
  stackValue,
  validateStack,
  variable,
} from "@errtraq/core";
import * as kvModule from "@errtraq/kv-dynamodb";
import { dynamoKv } from "@errtraq/kv-dynamodb/stack";
import * as lambdaModule from "@errtraq/platform-aws-lambda";
import { awsLambda } from "@errtraq/platform-aws-lambda/stack";
import * as queueModule from "@errtraq/queue-sqs";
import { SQS_MAX_BYTES, sqsQueue } from "@errtraq/queue-sqs/stack";
import * as storeModule from "@errtraq/store-dynamodb";
import { dynamoStore } from "@errtraq/store-dynamodb/stack";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { assertSafeStackImports } from "../scripts/adapter-stack-check.js";
import shared from "./aws-dynamodb.js";
import perTopic from "./aws-dynamodb-per-topic.js";

const copyStack = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value)) as T;

const names = (items: { binding: { name: string } }[]) =>
  items.map((item) => item.binding.name).sort();
describe("AWS descriptor stacks", () => {
  it("checks the platform-declared stack name limit before generation", () => {
    expect(
      validateStack({ ...copyStack(shared), name: "a".repeat(40) }),
    ).toEqual([]);
    expect(
      validateStack({ ...copyStack(shared), name: "a".repeat(41) }),
    ).toContainEqual({
      path: "name",
      message:
        "Stack name exceeds 40 characters allowed by platform aws-lambda",
    });
    const smaller = {
      ...copyStack(shared),
      name: "sixsix",
      platform: {
        ...shared.platform,
        manifest: { ...shared.platform.manifest, maxStackNameLength: 5 },
      },
    };
    expect(validateStack(smaller)).toContainEqual({
      path: "name",
      message: "Stack name exceeds 5 characters allowed by platform aws-lambda",
    });
  });
  it("derives functions, scoped bindings, policies, and a shared trigger", () => {
    expect(validateStack(shared)).toEqual([]);
    const view = deriveDeployment(shared);
    expect(view.functions.map((fn) => fn.id)).toEqual([
      "ingest",
      "api",
      "consumer",
      "cron",
    ]);
    const byId = Object.fromEntries(view.functions.map((fn) => [fn.id, fn]));
    expect(names(byId.ingest?.envBindings ?? [])).toEqual([
      "ERRTRAQ_BLOB_BUCKET",
      "ERRTRAQ_KV_TABLE",
      "ERRTRAQ_QUEUE_SHARED_URL",
      "ERRTRAQ_STORE_TABLE",
    ]);
    expect(names(byId.api?.envBindings ?? [])).toEqual([
      "ERRTRAQ_BLOB_BUCKET",
      "ERRTRAQ_STORE_TABLE",
    ]);
    expect(names(byId.consumer?.envBindings ?? [])).toEqual([
      "ERRTRAQ_BLOB_BUCKET",
      "ERRTRAQ_QUEUE_SOURCE_SHARED",
      "ERRTRAQ_STORE_TABLE",
    ]);
    expect(names(byId.cron?.envBindings ?? [])).toEqual([
      "ERRTRAQ_BLOB_BUCKET",
      "ERRTRAQ_QUEUE_SHARED_URL",
    ]);
    expect(byId.ingest?.http).toEqual(["ingest"]);
    expect(byId.api?.http).toEqual(["api"]);
    expect(byId.consumer?.settings).toMatchObject({ timeoutSec: 30 });
    expect(byId.ingest?.artifact).toEqual(artifact("ingest"));
    expect(
      byId.ingest?.policies.map((grant) => grant.policyOutput),
    ).toContainEqual(output("queue", "policies", "produce", "shared"));
    expect(
      byId.api?.policies.some((grant) => grant.selection === "queue"),
    ).toBe(false);
    expect(
      byId.consumer?.policies.map((grant) => grant.policyOutput),
    ).toContainEqual(output("queue", "policies", "consume", "shared"));
    for (const fn of view.functions) {
      for (const grant of fn.policies) {
        expect(grant.policyOutput).toEqual(
          output(grant.selection, "policies", grant.capability, grant.purpose),
        );
      }
    }
    const policyKeys = (id: string) =>
      (byId[id]?.policies ?? [])
        .map(
          (grant) => `${grant.selection}:${grant.capability}:${grant.purpose}`,
        )
        .sort();
    expect(policyKeys("ingest")).toEqual([
      "blob:delete:primary",
      "blob:write:primary",
      "kv:read:primary",
      "kv:write:primary",
      "queue:produce:shared",
      "store:read:primary",
    ]);
    expect(policyKeys("api")).toEqual([
      "blob:read:primary",
      "store:read:primary",
      "store:write:primary",
    ]);
    expect(policyKeys("consumer")).toEqual([
      "blob:delete:primary",
      "blob:read:primary",
      "blob:write:primary",
      "queue:consume:shared",
      "store:read:primary",
      "store:write:primary",
    ]);
    expect(policyKeys("cron")).toEqual([
      "blob:list:primary",
      "blob:read:primary",
      "queue:produce:shared",
    ]);
    expect(view.triggers).toEqual([
      {
        kind: "queue",
        functionId: "consumer",
        physical: "shared",
        eventSourceBinding: "ERRTRAQ_QUEUE_SOURCE_SHARED",
        resource: output("queue", "queues", "shared", "arn"),
        topics: ["ingest"],
        settings: {
          visibilityTimeoutSec: 180,
          batchSize: 10,
          dlq: { enabled: true, maxReceiveCount: 5 },
        },
      },
    ]);
    expect(
      shared.platform.infra.inputs(shared.platform.config, view),
    ).toMatchObject({
      functions: {
        ingest: { artifact: artifact("ingest"), http: ["ingest"] },
        consumer: { timeout_sec: 30 },
      },
      queue_triggers: {
        shared: {
          function_id: "consumer",
          resource: output("queue", "queues", "shared", "arn"),
          batch_size: 10,
          visibility_timeout_sec: 180,
        },
      },
    });
  });
  it("isolates queue bindings and policies per active topic", () => {
    expect(validateStack(perTopic)).toEqual([]);
    const view = deriveDeployment(perTopic);
    const ingest = view.functions.find((fn) => fn.id === "ingest");
    const consumer = view.functions.find((fn) => fn.id === "consumer");
    expect(names(ingest?.envBindings ?? [])).toContain(
      "ERRTRAQ_QUEUE_INGEST_URL",
    );
    expect(names(ingest?.envBindings ?? [])).not.toContain(
      "ERRTRAQ_QUEUE_NOTIFICATIONS_URL",
    );
    expect(names(consumer?.envBindings ?? [])).not.toContain(
      "ERRTRAQ_QUEUE_NOTIFICATIONS_URL",
    );
    expect(names(consumer?.envBindings ?? [])).not.toContain(
      "ERRTRAQ_QUEUE_INGEST_URL",
    );
    expect(
      ingest?.policies
        .filter((grant) => grant.selection === "queue")
        .map((grant) => grant.policyOutput),
    ).toEqual([output("queue", "policies", "produce", "ingest")]);
    expect(
      consumer?.policies
        .filter(
          (grant) =>
            grant.selection === "queue" && grant.capability === "consume",
        )
        .map((grant) => grant.policyOutput),
    ).toEqual([output("queue", "policies", "consume", "ingest")]);
    expect(
      view.triggers
        .filter((trigger) => trigger.kind === "queue")
        .map((trigger) => ({
          physical: trigger.physical,
          functionId: trigger.functionId,
          topics: trigger.topics,
        })),
    ).toEqual([
      { physical: "ingest", functionId: "consumer", topics: ["ingest"] },
    ]);
    expect(
      perTopic.queue.infra.topics?.routes["archive.project"].physical,
    ).toBe("archive_project");
  });
  it("provisions notification queues only when their feature is enabled", () => {
    const enabled = {
      ...copyStack(perTopic),
      features: { notifications: true },
    };
    const view = deriveDeployment(enabled);
    const inputs = enabled.queue.infra.inputs(enabled.queue.config, view);
    expect(Object.keys(inputs.physical_queues ?? {})).toEqual([
      "ingest",
      "notifications",
    ]);
    expect(
      view.triggers.filter((t) => t.kind === "queue").map((t) => t.physical),
    ).toEqual(["ingest", "notifications"]);
    expect(
      view.functions
        .find((fn) => fn.id === "consumer")
        ?.policies.map((grant) => grant.policyOutput),
    ).toContainEqual(output("queue", "policies", "consume", "notifications"));
  });
  it("threads the safe stack protection choice into both tables and the bucket", () => {
    const production = resolveStack(copyStack(shared));
    const disposable = resolveStack({
      ...copyStack(shared),
      protection: "disposable",
    });
    expect(production.protection).toBe("production");
    expect(disposable.protection).toBe("disposable");
    for (const stack of [production, disposable]) {
      const view = deriveDeployment(stack);
      for (const item of [stack.store, stack.kv, stack.blob])
        expect(item.infra.inputs(item.config, view).protection).toEqual(
          stackValue("protection"),
        );
    }
    expect(
      validateStack({ ...copyStack(shared), protection: "invalid" }).length,
    ).toBeGreaterThan(0);
  });
  it("grants cron the staged-envelope recovery capabilities", () => {
    const cron = deriveDeployment(perTopic).functions.find(
      (fn) => fn.id === "cron",
    );
    expect(
      cron?.policies.map((grant) => [
        grant.selection,
        grant.capability,
        grant.purpose,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["blob", "read", "primary"],
        ["blob", "list", "primary"],
        ["queue", "produce", "ingest"],
      ]),
    );
    expect(cron?.envBindings.map((item) => item.binding.name)).toContain(
      "ERRTRAQ_QUEUE_INGEST_URL",
    );
  });
  it("publishes honest adapter capabilities, resource policies and AWS bounds", () => {
    expect(SQS_MAX_BYTES).toBe(1_048_576);
    expect(sqsQueue().manifest.capabilities).toMatchObject({
      delivery: "push",
      maxBytes: 1_048_576,
      delay: true,
      dlq: true,
      visibilityTimeout: true,
    });
    expect(dynamoStore().manifest.capabilities).toEqual({
      textSearch: false,
      lastSeenRangeOnOtherSort: false,
      deleteStrategy: "explicit",
    });
    expect(s3Blob().infra.capabilities.write?.staging).toEqual(
      outPolicy("write", "staging"),
    );
    expect(dynamoKv().infra.capabilities.write?.primary).toEqual(
      outPolicy("write", "primary"),
    );
    expect(dynamoKv().infra.capabilities.delete?.primary).toEqual(
      outPolicy("delete", "primary"),
    );
    expect(() => sqsQueue({ batchSize: 11 })).toThrow();
    expect(() => sqsQueue({ visibilityTimeoutSec: 43201 })).toThrow();
    expect(() =>
      awsLambda({ settings: { consumer: { timeoutSec: 901 } } }),
    ).toThrow();
    const bad = {
      ...copyStack(shared),
      queue: sqsQueue({ visibilityTimeoutSec: 179 }),
    };
    expect(
      validateStack(bad).some((issue) => issue.message.includes("six times")),
    ).toBe(true);
    const reserved = {
      ...copyStack(shared),
      blob: {
        ...shared.blob,
        infra: {
          ...shared.blob.infra,
          bindings: [
            {
              name: "AWS_REGION",
              kind: "env" as const,
              purpose: "primary",
              value: "x",
            },
          ],
        },
      },
    };
    expect(
      validateStack(reserved).some((issue) =>
        issue.message.includes("Reserved binding name"),
      ),
    ).toBe(true);
  });
  it("carries Lambda settings, grouping, HTTP exposure, and queue options into the view", () => {
    const customized = {
      ...copyStack(shared),
      platform: awsLambda({
        split: ["consumer", "cron"],
        http: ["ingest"],
        settings: {
          consumer: { memoryMb: 1024, timeoutSec: 45, architecture: "arm64" },
        },
      }),
      queue: sqsQueue({
        visibilityTimeoutSec: 270,
        batchSize: 5,
        maxConcurrency: 7,
        dlq: false,
      }),
    };
    expect(validateStack(customized)).toEqual([]);
    const view = deriveDeployment(customized);
    const web = view.functions.find((fn) => fn.roles.includes("ingest"));
    const consumer = view.functions.find((fn) => fn.roles.includes("consumer"));
    expect(web?.roles).toEqual(["ingest", "api"]);
    expect(web?.http).toEqual(["ingest"]);
    expect(consumer?.settings).toMatchObject({
      memoryMb: 1024,
      timeoutSec: 45,
      architecture: "arm64",
    });
    expect(view.triggers[0]).toMatchObject({
      settings: {
        visibilityTimeoutSec: 270,
        batchSize: 5,
        maxConcurrency: 7,
        dlq: { enabled: false },
      },
    });
    expect(
      customized.platform.infra.inputs(customized.platform.config, view),
    ).toMatchObject({
      functions: {
        consumer: { memory_mb: 1024, timeout_sec: 45, architecture: "arm64" },
      },
      queue_triggers: { shared: { batch_size: 5, max_concurrency: 7 } },
    });
  });
  it("rejects config references unsupported by the Lambda platform", () => {
    const base = copyStack(shared);
    for (const [kind, ref] of [
      ["env", env("EXTERNAL")],
      ["variable", variable("EXTERNAL")],
    ] as const) {
      const v = {
        ...base,
        variables: { EXTERNAL: { type: "string" as const, sensitive: false } },
        store: {
          ...base.store,
          manifest: {
            ...base.store.manifest,
            configSchema: z.object({ endpoint: configReference(z.string()) }),
          },
          config: { endpoint: ref },
        },
      };
      expect(
        validateStack(v).some((issue) =>
          issue.message.includes(`does not support ${kind} config references`),
        ),
      ).toBe(true);
    }
  });
  it("rejects Lambda queue triggers without a visibility timeout", () => {
    const queue = sqsQueue();
    if (!queue.infra.topics) throw new Error("missing queue routes");
    const v = {
      ...copyStack(shared),
      queue: {
        ...queue,
        manifest: {
          ...queue.manifest,
          capabilities: {
            ...queue.manifest.capabilities,
            visibilityTimeout: false,
          },
        },
        infra: {
          ...queue.infra,
          topics: {
            ...queue.infra.topics,
            settings: { shared: { batchSize: 10 } },
          },
        },
      },
    };
    expect(
      validateStack(v).some((issue) =>
        issue.message.includes("requires a visibility timeout for Lambda"),
      ),
    ).toBe(true);
  });
  it("passes per-function URL auth, concurrency and runtime settings", () => {
    const v = {
      ...copyStack(shared),
      platform: awsLambda({
        runtime: "nodejs20.x",
        handler: "app.handle",
        settings: { ingest: { urlAuth: "AWS_IAM", reservedConcurrency: 5 } },
      }),
    };
    expect(validateStack(v)).toEqual([]);
    const view = deriveDeployment(v);
    expect(v.platform.infra.inputs(v.platform.config, view)).toMatchObject({
      runtime: "nodejs20.x",
      handler: "app.handle",
      functions: {
        ingest: { auth_type: "AWS_IAM", reserved_concurrency: 5 },
        api: { auth_type: "NONE" },
      },
    });
    expect(() =>
      awsLambda({ settings: { ingest: { reservedConcurrency: -1 } } }),
    ).toThrow();
  });
  it("keeps per-topic role policy counts safely below the inline guard budget", () => {
    const view = deriveDeployment(perTopic);
    for (const fn of view.functions) {
      expect(fn.secretReads).toHaveLength(0);
      // Each current generated policy is budgeted at 1024 characters and logging at 1024.
      expect((fn.policies.length + 1) * 1024).toBeLessThan(10240);
    }
    expect(Math.max(...view.functions.map((fn) => fn.policies.length))).toBe(6);
  });
  it("keeps stack helpers free of runtime imports", async () => {
    for (const path of [
      "../packages/adapters/blob-s3/src/stack.ts",
      "../packages/adapters/kv-dynamodb/src/stack.ts",
      "../packages/adapters/queue-sqs/src/stack.ts",
      "../packages/adapters/store-dynamodb/src/stack.ts",
      "../packages/platforms/aws-lambda/src/stack.ts",
    ]) {
      await expect(
        assertSafeStackImports(new URL(path, import.meta.url)),
      ).resolves.toBeUndefined();
    }
  });
  it("exports only the runtime triple and fails clearly until M3", () => {
    const context = { config: {}, bindings: {}, dependencies: {} };
    for (const [name, module] of [
      ["store-dynamodb", storeModule],
      ["kv-dynamodb", kvModule],
      ["platform-aws-lambda", lambdaModule],
    ] as const) {
      expect(Object.keys(module).sort()).toEqual([
        "create",
        "infra",
        "manifest",
      ]);
      expect(() => module.create(context)).toThrow(
        `${name} runtime not implemented until M3`,
      );
    }
    expect(Object.keys(queueModule).sort()).toEqual([
      "create",
      "infra",
      "manifest",
    ]);
    expect(() => queueModule.create({ ...context, config: {} })).toThrow(
      "Missing SQS region",
    );
    expect(Object.keys(blobModule).sort()).toEqual([
      "create",
      "infra",
      "manifest",
    ]);
    expect(() => blobModule.create(context)).toThrow(
      "Missing S3 bucket binding",
    );
  });
});
function outPolicy(capability: string, purpose: string) {
  return out("policies", capability, purpose);
}
