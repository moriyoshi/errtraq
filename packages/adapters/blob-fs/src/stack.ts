import type {
  AdapterManifest,
  AdapterSelection,
  InfraDescriptor,
} from "@errtraq/core";
import { z } from "zod";
export const configSchema = z.strictObject({ root: z.string().min(1) });
export type BlobConfig = z.infer<typeof configSchema>;
/** The local key index is maintained by one process; reopen after external changes. */
export const manifest: AdapterManifest<BlobConfig> = {
  id: "blob-fs",
  kind: "blob",
  configSchema,
  runtimes: ["node"],
  capabilities: {},
};
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<BlobConfig> = {
  module: { provider: "local", component: "blob-fs", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {},
  grants: [],
};
export function fsBlob(config: BlobConfig): AdapterSelection<BlobConfig> {
  return { manifest, infra, config, runtimeModule: "@errtraq/blob-fs" };
}
