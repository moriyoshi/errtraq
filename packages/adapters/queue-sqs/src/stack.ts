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
export { SQS_MAX_BYTES } from "./constants.js";

import { SQS_MAX_BYTES } from "./constants.js";
export const configSchema = z.strictObject({
  requestTimeoutMs: z.number().int().min(1).max(300000).optional(),
  overallTimeoutMs: z.number().int().min(1).max(300000).optional(),
  mode: z.enum(["shared", "per-topic"]).default("shared"),
  visibilityTimeoutSec: z.number().int().min(1).max(43200).default(180),
  batchSize: z.number().int().min(1).max(10).default(10),
  maxConcurrency: z.number().int().min(2).max(1000).optional(),
  dlq: z.boolean().default(true),
  maxReceiveCount: z.number().int().min(1).max(1000).default(5),
  /** Existing operator-owned SNS topic notified by the queue alarms; never created here. */
  alarmTopicArn: z
    .string()
    .regex(
      /^arn:aws(?:-cn|-us-gov)?:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}(?:\.fifo)?$/,
    )
    .optional(),
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
    grouping: "per-key-serial",
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
  const keys = [...new Set([...Object.values(physical), "record"])];
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
      record: {
        physical: "record",
        producerBinding: "ERRTRAQ_QUEUE_RECORD_URL",
        grouping: "per-key-serial",
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
          dlq:
            config.dlq || key === "record"
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
        policies: { map: { map: "json-document" } },
      },
    },
    inputs: (_config, deployment) => ({
      name: stackValue("name"),
      tags: stackValue("tags"),
      ...(config.alarmTopicArn === undefined
        ? {}
        : { alarm_topic_arn: config.alarmTopicArn }),
      physical_queues: Object.fromEntries(
        [
          ...new Set(
            deployment.triggers.flatMap((trigger) =>
              trigger.kind === "queue" ? [trigger.physical] : [],
            ),
          ),
        ].map((key) => [
          key,
          {
            ...(key === "record" ? { fifo: true } : {}),
            visibility_timeout_sec: config.visibilityTimeoutSec,
            dlq_enabled: config.dlq || key === "record",
            max_receive_count: config.maxReceiveCount,
          },
        ]),
      ),
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
    runtimeModule: "@errtraq/queue-sqs/runtime",
  };
}
