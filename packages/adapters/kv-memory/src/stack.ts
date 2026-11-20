import type {
  AdapterManifest,
  AdapterSelection,
  InfraDescriptor,
} from "@errtraq/core";
import { z } from "zod";
export const configSchema = z.strictObject({});
export type KvConfig = z.infer<typeof configSchema>;
export const manifest: AdapterManifest<KvConfig> = {
  id: "kv-memory",
  kind: "kv",
  configSchema,
  runtimes: ["node"],
  capabilities: {},
};
// TODO(M2a): local descriptors will be revised with the infra model.
export const infra: InfraDescriptor<KvConfig> = {
  module: "local/kv-memory",
  inputs: () => ({}),
  bindings: {},
  grants: [],
  triggers: [],
};
export function memoryKv(config: KvConfig = {}): AdapterSelection<KvConfig> {
  return { manifest, infra, config, runtimeModule: "@errtraq/kv-memory" };
}
