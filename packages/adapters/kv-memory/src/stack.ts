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
  requires: ["long-lived-process", "shared-process-state"],
  capabilities: {},
};
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<KvConfig> = {
  module: { provider: "local", component: "kv-memory", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: { read: { primary: null }, write: { primary: null } },
  resources: { primary: "local" },
};
export function memoryKv(config: KvConfig = {}): AdapterSelection<KvConfig> {
  return { manifest, infra, config, runtimeModule: "@errtraq/kv-memory" };
}
