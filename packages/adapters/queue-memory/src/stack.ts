import type {
  AdapterManifest,
  AdapterSelection,
  InfraDescriptor,
} from "@errtraq/core";
import { z } from "zod";

export const QUEUE_MAX_BYTES = 262144;
export const configSchema = z.strictObject({
  maxAttempts: z.number().int().positive().default(10),
});
export type QueueConfig = z.input<typeof configSchema>;
export const manifest: AdapterManifest = {
  id: "queue-memory",
  kind: "queue",
  configSchema,
  runtimes: ["node"],
  requires: ["long-lived-process", "shared-process-state"],
  capabilities: {
    delivery: "pull",
    maxBytes: QUEUE_MAX_BYTES,
    delay: true,
    dlq: false,
  },
};
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<QueueConfig> = {
  module: { provider: "local", component: "queue-memory", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {},
  grants: [],
  topics: {
    mode: "shared",
    routes: {
      ingest: {
        physical: "memory",
        producers: ["ingest"],
        consumer: "consumer",
        resource: "memory",
      },
      "archive.project": {
        physical: "memory",
        producers: ["cron"],
        consumer: "consumer",
        resource: "memory",
      },
      notifications: {
        physical: "memory",
        producers: ["consumer"],
        consumer: "consumer",
        resource: "memory",
      },
    },
  },
};
export function memoryQueue(
  config: QueueConfig = {},
): AdapterSelection<QueueConfig> {
  return { manifest, infra, config, runtimeModule: "@errtraq/queue-memory" };
}
