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
    visibilityTimeout: false,
    grouping: "per-key-serial",
  },
};
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<QueueConfig> = {
  module: { provider: "local", component: "queue-memory", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {
    produce: { memory: null, memory_record: null },
    consume: { memory: null, memory_record: null },
  },
  resources: { memory: "memory", memory_record: "memory_record" },
  topics: {
    mode: "shared",
    routes: {
      ingest: {
        physical: "memory",
      },
      "archive.project": {
        physical: "memory",
      },
      notifications: {
        physical: "memory",
      },
      record: { physical: "memory_record", grouping: "per-key-serial" },
    },
  },
};
export function memoryQueue(
  config: QueueConfig = {},
): AdapterSelection<QueueConfig> {
  return { manifest, infra, config, runtimeModule: "@errtraq/queue-memory" };
}
