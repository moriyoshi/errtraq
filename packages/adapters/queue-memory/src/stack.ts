import type {
  AdapterManifest,
  AdapterSelection,
  InfraDescriptor,
} from "@errtraq/core";
import { z } from "zod";

export const configSchema = z.strictObject({});
export type QueueConfig = z.input<typeof configSchema>;
export const manifest: AdapterManifest = {
  id: "queue-memory",
  kind: "queue",
  configSchema,
  runtimes: ["node"],
  capabilities: { delivery: "pull", maxBytes: 262144, delay: true, dlq: false },
};
// TODO(M2a): local descriptors will be revised with the infra model.
export const infra: InfraDescriptor<QueueConfig> = {
  module: "local/queue-memory",
  inputs: () => ({}),
  bindings: {},
  grants: [],
  triggers: [],
};
export function memoryQueue(
  config: QueueConfig = {},
): AdapterSelection<QueueConfig> {
  return { manifest, infra, config, runtimeModule: "@errtraq/queue-memory" };
}
