import {
  type AdapterManifest,
  type AdapterSelection,
  type Binding,
  type CoreTopic,
  type InfraDescriptor,
  out,
  stackValue,
  type TopicMapping,
} from "@errtraq/core";
import { z } from "zod";

// SQS counts the entire encoded message body; M3 must include its envelope overhead.
export const SQS_MAX_BYTES = 1_048_576;
export const configSchema = z.strictObject({
  mode: z.enum(["shared", "per-topic"]).default("shared"),
  visibilityTimeoutSec: z.number().int().min(1).max(43200).default(180),
  batchSize: z.number().int().min(1).max(10).default(10),
  maxConcurrency: z.number().int().min(2).max(1000).optional(),
  dlq: z.boolean().default(true),
  maxReceiveCount: z.number().int().min(1).max(1000).default(5),
});
export type Config = z.input<typeof configSchema>;
type ResolvedConfig = z.output<typeof configSchema>;
export const manifest: AdapterManifest = {
  id: "queue-sqs",
  kind: "queue",
  configSchema,
  runtimes: ["node"],
  requires: [],
  capabilities: {
    delivery: "push",
    maxBytes: SQS_MAX_BYTES,
    delay: true,
    dlq: true,
    visibilityTimeout: true,
  },
};
function descriptor(config: ResolvedConfig): InfraDescriptor<Config> {
  const physical: Record<CoreTopic, string> =
    config.mode === "shared"
      ? {
          ingest: "shared",
          "archive.project": "shared",
          notifications: "shared",
        }
      : {
          ingest: "ingest",
          "archive.project": "archive_project",
          notifications: "notifications",
        };
  const keys = [...new Set(Object.values(physical))];
  const bindings: Binding[] = keys.map((key) => ({
    name: `ERRTRAQ_QUEUE_${key.toUpperCase()}_URL`,
    kind: "env",
    purpose: key,
    capabilities: ["produce"],
    value: out("queues", key, "url"),
  }));
  const topics: TopicMapping = {
    mode: config.mode,
    routes: {
      ingest: {
        physical: physical.ingest,
        producerBinding: `ERRTRAQ_QUEUE_${physical.ingest.toUpperCase()}_URL`,
      },
      "archive.project": {
        physical: physical["archive.project"],
        producerBinding: `ERRTRAQ_QUEUE_${physical["archive.project"].toUpperCase()}_URL`,
      },
      notifications: {
        physical: physical.notifications,
        producerBinding: `ERRTRAQ_QUEUE_${physical.notifications.toUpperCase()}_URL`,
      },
    },
    settings: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          visibilityTimeoutSec: config.visibilityTimeoutSec,
          batchSize: config.batchSize,
          ...(config.maxConcurrency === undefined
            ? {}
            : { maxConcurrency: config.maxConcurrency }),
          dlq: config.dlq
            ? { enabled: true, maxReceiveCount: config.maxReceiveCount }
            : { enabled: false },
        },
      ]),
    ),
  };
  return {
    module: {
      provider: "aws",
      component: "sqs",
      outputs: {
        queues: { map: { map: "string" } },
        policies: { map: { map: "json" } },
      },
    },
    inputs: () => ({
      name: stackValue("name"),
      region: stackValue("region"),
      tags: stackValue("tags"),
      physical_queues: keys,
      visibility_timeout_sec: config.visibilityTimeoutSec,
      dlq_enabled: config.dlq,
      max_receive_count: config.maxReceiveCount,
    }),
    resources: Object.fromEntries(
      keys.map((key) => [key, out("queues", key, "arn")]),
    ),
    capabilities: Object.fromEntries(
      ["produce", "consume"].map((capability) => [
        capability,
        Object.fromEntries(
          keys.map((key) => [key, out("policies", capability, key)]),
        ),
      ]),
    ),
    bindings,
    topics,
  };
}
/** Default shared descriptor; the helper specializes its resources to the chosen mode. */
export const infra: InfraDescriptor<Config> = descriptor(
  configSchema.parse({}),
);
export function sqsQueue(config: Config = {}): AdapterSelection<Config> {
  const parsed = configSchema.parse(config);
  return {
    manifest,
    infra: descriptor(parsed),
    config: parsed,
    runtimeModule: "@errtraq/queue-sqs",
  };
}
