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
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<KvConfig> = {
  module: { provider: "local", component: "kv-memory", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {},
  grants: [],
};
export function memoryKv(config: KvConfig = {}): AdapterSelection<KvConfig> {
  return { manifest, infra, config, runtimeModule: "@errtraq/kv-memory" };
}
