import type { AdapterManifest, InfraDescriptor } from "@moriyoshi/errtraq-core";
import { z } from "zod";

/**
 * Catalog authentication. Secrets are identifiers resolved through the host secret source when
 * the first request needs them; the stack config never holds a secret value.
 */
export const catalogAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({
    type: z.literal("bearer"),
    tokenSecret: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("oauth2"),
    clientId: z.string().min(1),
    clientSecretSecret: z.string().min(1),
    tokenEndpoint: z.url().optional(),
    scope: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal("sigv4"),
    region: z.string().min(1),
    /** `s3tables` (default) for S3 Tables; `glue` for the Glue REST endpoint. */
    signingName: z.string().min(1).optional(),
  }),
]);
export const catalogConfigSchema = z.strictObject({
  /** The REST base URI, for example `http://localhost:8181/catalog`. */
  uri: z.url(),
  /** Lakekeeper warehouse name, or the table bucket ARN on S3 Tables. */
  warehouse: z.string().min(1).optional(),
  auth: catalogAuthSchema.default({ type: "none" }),
  requestTimeoutMs: z.number().int().min(1).max(300000).optional(),
});
export const configSchema = z.strictObject({
  catalog: catalogConfigSchema,
  /** Iceberg namespace holding the `events` table. */
  namespace: z.string().min(1).default("errtraq"),
  // TODO(M4f): engine options (duckdb memory, threads, staging location, format version).
});
export type Config = z.input<typeof configSchema>;
export type ParsedConfig = z.output<typeof configSchema>;
export type CatalogConfigInput = z.input<typeof catalogConfigSchema>;

export const manifest: AdapterManifest<Config> = {
  id: "archive-iceberg",
  kind: "archive",
  configSchema,
  runtimes: ["node"],
  requires: [],
  // TODO(M4f): derive from the configured table format version (D3: v2 position deletes by default).
  capabilities: { rowDelete: "position-delete" },
  childKinds: { catalog: "catalog", engine: "engine" },
};

// TODO(M4i): AWS provisioning (S3 Tables table bucket, namespace, maintenance configuration, IAM
// for the s3tables REST actions). Until the HCL module exists the descriptor names the same
// "local, no module" placeholder as the in-memory adapters: the catalog is external (Lakekeeper
// brought by the operator or by docker/archive).
export const infra: InfraDescriptor<Config> = {
  module: { provider: "local", component: "archive-iceberg", outputs: {} },
  inputs: () => ({}),
  bindings: [],
  capabilities: {
    read: { primary: null },
    write: { primary: null },
    delete: { primary: null },
  },
  resources: { primary: "local" },
};
