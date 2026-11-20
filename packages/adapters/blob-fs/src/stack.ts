import type {
  AdapterManifest,
  AdapterSelection,
  InfraDescriptor,
} from "@errtraq/core";
import { z } from "zod";
export const configSchema = z.strictObject({ root: z.string().min(1) });
export type BlobConfig = z.infer<typeof configSchema>;
export const manifest: AdapterManifest<BlobConfig> = {
  id: "blob-fs",
  kind: "blob",
  configSchema,
  runtimes: ["node"],
  capabilities: {},
};
// TODO(M2a): local descriptors will be revised with the infra model.
export const infra: InfraDescriptor<BlobConfig> = {
  module: "local/blob-fs",
  inputs: () => ({}),
  bindings: {},
  grants: [],
  triggers: [],
};
export function fsBlob(config: BlobConfig): AdapterSelection<BlobConfig> {
  return { manifest, infra, config, runtimeModule: "@errtraq/blob-fs" };
}
