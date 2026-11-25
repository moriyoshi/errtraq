import {
  type AdapterManifest,
  type AdapterSelection,
  type InfraDescriptor,
  out,
  stackValue,
} from "@moriyoshi/errtraq-core";
import { z } from "zod";

/** How the adapter obtains Google credentials. */
export const authSchema = z.discriminatedUnion("mode", [
  /** The metadata server (Cloud Run, GCE, GKE); signing goes through IAM Credentials. */
  z.strictObject({
    mode: z.literal("metadata"),
    host: z.string().min(1).optional(),
  }),
  /** A service account JSON key read through the secret source (non-GCP hosts, CI). */
  z.strictObject({
    mode: z.literal("service-account"),
    keySecretId: z.string().min(1),
  }),
  /** A pre-minted access token held in an environment variable (tests). */
  z.strictObject({ mode: z.literal("static"), tokenEnv: z.string().min(1) }),
  /** No Authorization header; accepted only together with an endpoint override (emulators). */
  z.strictObject({ mode: z.literal("none") }),
]);
export const configSchema = z.strictObject({
  /** Bucket location. There is deliberately no default: it is immutable after creation (D7). */
  location: z.string().min(1),
  auth: authSchema.default({ mode: "metadata" }),
  /** Emulator or private endpoint override (JSON API root). */
  endpoint: z.url().optional(),
  requestTimeoutMs: z.number().int().min(1).max(300000).optional(),
  overallTimeoutMs: z.number().int().min(1).max(300000).optional(),
});
export type Config = z.input<typeof configSchema>;
export const manifest: AdapterManifest = {
  id: "blob-gcs",
  kind: "blob",
  configSchema,
  runtimes: ["node", "workers"],
  requires: [],
  capabilities: {},
};
// The HCL module is infra/modules/google/gcs; its optional lifecycle inputs (claim retention, event
// retention, orphan margin) keep their defaults here.
export const infra: InfraDescriptor<Config> = {
  module: {
    provider: "google",
    component: "gcs",
    outputs: {
      bucket_name: "string",
      bucket_id: "string",
      policies: { map: { map: "json-document" } },
    },
  },
  inputs: (config) => ({
    name: stackValue("name"),
    protection: stackValue("protection"),
    location: config.location,
  }),
  resources: { primary: out("bucket_id") },
  capabilities: {
    read: { primary: out("policies", "read", "primary") },
    write: { primary: out("policies", "write", "primary") },
    delete: { primary: out("policies", "delete", "primary") },
    list: { primary: out("policies", "list", "primary") },
  },
  bindings: [
    {
      name: "ERRTRAQ_BLOB_BUCKET",
      kind: "env",
      purpose: "primary",
      value: out("bucket_name"),
    },
  ],
};
export function gcsBlob(config: Config): AdapterSelection<Config> {
  return {
    manifest,
    infra,
    config,
    runtimeModule: "@moriyoshi/errtraq-blob-gcs/runtime",
  };
}
