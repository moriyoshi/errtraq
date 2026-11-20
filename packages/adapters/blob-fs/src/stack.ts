import {
  type AdapterManifest,
  type AdapterSelection,
  configReference,
  type InfraDescriptor,
} from "@errtraq/core";
import { z } from "zod";
export const configSchema = z.strictObject({ root: z.string().min(1) });
export type BlobConfig = z.infer<typeof configSchema>;
const stackConfigSchema = z.strictObject({
  root: configReference(z.string().min(1)),
});
type BlobStackConfig = z.input<typeof stackConfigSchema>;
/** The local key index is maintained by one process; reopen after external changes. */
export const manifest: AdapterManifest = {
  id: "blob-fs",
  kind: "blob",
  configSchema: stackConfigSchema,
  runtimes: ["node"],
  requires: [
    "writable-filesystem",
    "long-lived-process",
    "shared-process-state",
  ],
  capabilities: {},
};
// TODO(M2b): provide local module generation semantics.
export const infra: InfraDescriptor<BlobStackConfig> = {
  module: { provider: "local", component: "blob-fs", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {},
  grants: [],
};
export function fsBlob(
  config: BlobStackConfig,
): AdapterSelection<BlobStackConfig> {
  return { manifest, infra, config, runtimeModule: "@errtraq/blob-fs" };
}
