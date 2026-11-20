import {
  constructDeployedStack,
  deriveDeployment,
  output,
} from "@errtraq/core";
import { describe, expect, it } from "vitest";
import shared from "./aws-dynamodb.js";
import perTopic from "./aws-dynamodb-per-topic.js";

describe.each([shared, perTopic])("deployed runtime: $name", (stack) => {
  it("constructs only ingest adapters and reads only their delivered bindings", async () => {
    const calls: { module: string; context: Record<string, unknown> }[] = [];
    const reads: string[] = [];
    const queueName =
      stack === shared
        ? "ERRTRAQ_QUEUE_SHARED_URL"
        : "ERRTRAQ_QUEUE_INGEST_URL";
    const values: Record<string, string> = {
      ERRTRAQ_STORE_TABLE: "store-table",
      ERRTRAQ_KV_TABLE: "kv-table",
      ERRTRAQ_BLOB_BUCKET: "blob-bucket",
      [queueName]: "queue-url",
    };
    const environment = new Proxy(values, {
      get(target, key, receiver) {
        if (typeof key === "string") reads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });
    const built = await constructDeployedStack(
      stack,
      "ingest",
      environment,
      async (module) => ({
        create(context: Record<string, unknown>) {
          calls.push({ module, context });
          return {};
        },
      }),
    );
    expect([...built.instances.keys()].sort()).toEqual([
      "blob",
      "kv",
      "queue",
      "store",
    ]);
    expect(calls.map((item) => item.module).sort()).toEqual([
      "@errtraq/blob-s3",
      "@errtraq/kv-dynamodb",
      "@errtraq/queue-sqs",
      "@errtraq/store-dynamodb",
    ]);
    expect(reads.sort()).toEqual(Object.keys(values).sort());
    expect(
      calls.find((item) => item.module === "@errtraq/queue-sqs")?.context,
    ).toMatchObject({
      bindings: { [queueName]: "queue-url" },
      queueConsumers: [],
    });
    await built.close();
  });
  it("uses the delivered event-source identifier for the consumer mapping", async () => {
    const fn = deriveDeployment(stack).functions.find(
      (item) => item.id === "consumer",
    );
    if (!fn) throw new Error("missing consumer");
    const environment = Object.fromEntries(
      fn.envBindings.map((item) => [
        item.binding.name,
        `value:${item.binding.name}`,
      ]),
    );
    let queueContext: Record<string, unknown> | undefined;
    const built = await constructDeployedStack(
      stack,
      "consumer",
      environment,
      async (module) => ({
        create(context: Record<string, unknown>) {
          if (module === "@errtraq/queue-sqs") queueContext = context;
          return {};
        },
      }),
    );
    const name =
      stack === shared
        ? "ERRTRAQ_QUEUE_SOURCE_SHARED"
        : "ERRTRAQ_QUEUE_SOURCE_INGEST";
    const deployment = deriveDeployment(stack);
    const inputs = stack.platform.infra.inputs(
      stack.platform.config,
      deployment,
    );
    expect(inputs).toMatchObject({
      functions: {
        consumer: {
          environment: {
            [name]: output(
              "queue",
              "queues",
              stack === shared ? "shared" : "ingest",
              "arn",
            ),
          },
        },
      },
    });
    expect(queueContext?.queueConsumers).toEqual([
      {
        eventSource: `value:${name}`,
        physical: stack === shared ? "shared" : "ingest",
        topics: ["ingest"],
      },
    ]);
    await built.close();
  });
  it("closes constructed adapters in reverse order when a later factory fails", async () => {
    const fn = deriveDeployment(stack).functions.find(
      (item) => item.id === "ingest",
    );
    if (!fn) throw new Error("missing ingest");
    const environment = Object.fromEntries(
      fn.envBindings.map((item) => [item.binding.name, "value"]),
    );
    const made: string[] = [];
    const closed: string[] = [];
    await expect(
      constructDeployedStack(stack, "ingest", environment, async (module) => ({
        create() {
          if (made.length === 2) throw new Error("factory failed");
          made.push(module);
          return {
            close() {
              closed.push(module);
            },
          };
        },
      })),
    ).rejects.toThrow("factory failed");
    expect(closed).toEqual([...made].reverse());
  });
});
