import {
  constructDeployedStack,
  deriveDeployment,
  output,
} from "@errtraq/core";
import { create as createSqs } from "@errtraq/queue-sqs";
import { describe, expect, it, vi } from "vitest";
import shared from "./aws-dynamodb.js";
import perTopic from "./aws-dynamodb-per-topic.js";

describe.each([shared, perTopic])("deployed runtime: $name", (stack) => {
  it("constructs the SQS producer from the delivered queue binding", async () => {
    const fn = deriveDeployment(stack).functions.find(
      (item) => item.id === "ingest",
    );
    if (!fn) throw new Error("missing ingest function");
    const environment = Object.fromEntries(
      fn.envBindings.map(({ binding }) => [
        binding.name,
        "https://sqs.us-east-1.amazonaws.com/123456789012/test",
      ]),
    );
    Object.assign(environment, {
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "fixture",
      AWS_SECRET_ACCESS_KEY: "fixture",
    });
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      return new Response(
        JSON.stringify({
          Successful: body.Entries.map((entry: { Id: string }) => ({
            Id: entry.Id,
          })),
        }),
      );
    });
    try {
      const built = await constructDeployedStack(
        stack,
        "ingest",
        environment,
        async (module) =>
          module === "@errtraq/queue-sqs"
            ? { create: createSqs }
            : { create: () => ({}) },
      );
      const queue = built.instances.get("queue");
      if (!queue || typeof queue !== "object" || !("producer" in queue))
        throw new Error("missing queue");
      const actual = queue as ReturnType<typeof createSqs>;
      await actual.producer.send("ingest", [{ key: "test", body: 1 }]);
      expect(requests[0]?.QueueUrl).toBe(
        "https://sqs.us-east-1.amazonaws.com/123456789012/test",
      );
      await built.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("rejects an empty deployed binding", async () => {
    const fn = deriveDeployment(stack).functions.find(
      (item) => item.id === "ingest",
    );
    if (!fn) throw new Error("missing ingest function");
    const env = Object.fromEntries(
      fn.envBindings.map(({ binding }) => [binding.name, "ok"]),
    );
    env.ERRTRAQ_STORE_TABLE = "";
    await expect(
      constructDeployedStack(stack, "ingest", env, async () => ({
        create: () => ({}),
      })),
    ).rejects.toThrow("Missing deployed binding ERRTRAQ_STORE_TABLE");
  });
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
      calls.find((item) => item.module === "@errtraq/blob-s3")?.context
        .environment,
    ).toBe(environment);
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
