import type {
  AdapterManifest,
  AdapterSelection,
  InfraDescriptor,
} from "@moriyoshi/errtraq-core";
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
  /**
   * Ignore a server-advertised `overrides.uri` (and `defaults.uri`) and keep calling `uri`.
   * Lakekeeper derives the advertised URI from the request Host header, which is wrong behind a
   * proxy. Off by default: the REST spec says to follow the server.
   */
  ignoreServerUri: z.boolean().default(false),
});

/** S3 settings for the DuckDB `httpfs` secret. Credentials are never stored in the config. */
export const engineS3Schema = z.strictObject({
  /** Defaults to `AWS_REGION` / `AWS_DEFAULT_REGION`, then `us-east-1`. */
  region: z.string().min(1).optional(),
  /** `host[:port]` without a scheme (DuckDB syntax), for example `winterbaume:5555`. */
  endpoint: z
    .string()
    .regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/)
    .optional(),
  urlStyle: z.enum(["path", "vhost"]).default("vhost"),
  useSsl: z.boolean().default(true),
  /**
   * Secret identifiers resolved through the secret source. When all of `accessKeyIdSecret` and
   * `secretAccessKeySecret` are absent, credentials come from the `awsCredentials` binding, then
   * from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` (the Lambda case).
   */
  accessKeyIdSecret: z.string().min(1).optional(),
  secretAccessKeySecret: z.string().min(1).optional(),
  sessionTokenSecret: z.string().min(1).optional(),
});

export const engineConfigSchema = z.strictObject({
  /** `lakekeeper` attaches a REST catalog; `s3_tables` attaches with `ENDPOINT_TYPE s3_tables`. */
  catalogType: z.enum(["lakekeeper", "s3_tables"]).default("lakekeeper"),
  /** Iceberg format version of a newly created table. 3 (deletion vectors) is the default (D3). */
  formatVersion: z.union([z.literal(2), z.literal(3)]).default(3),
  /** DuckDB `memory_limit`, for example `768MB`. */
  memoryLimit: z
    .string()
    .regex(/^\d+(\.\d+)?\s?(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i)
    .optional(),
  threads: z.number().int().min(1).max(256).optional(),
  /** DuckDB `home_directory`; must be writable (on Lambda only `/tmp` is). */
  homeDirectory: z.string().min(1).default("/tmp/errtraq-duckdb"),
  /** DuckDB `extension_directory`; for the container image, the directory the extensions are baked into. */
  extensionDirectory: z.string().min(1).optional(),
  /**
   * `runtime-install` runs `INSTALL` before `LOAD` (development, ZIP deployments with egress).
   * `preinstalled` is container mode: autoinstall and autoload are off and extensions are only
   * `LOAD`ed from `extensionDirectory`.
   */
  extensionMode: z
    .enum(["runtime-install", "preinstalled"])
    .default("runtime-install"),
  s3: engineS3Schema.prefault({}),
  /** Commit-conflict retry: attempts (including the first) and the jittered backoff bounds. */
  retry: z
    .strictObject({
      maxAttempts: z.number().int().min(1).max(20).default(8),
      baseDelayMs: z.number().int().min(0).max(60000).default(100),
      maxDelayMs: z.number().int().min(0).max(60000).default(5000),
    })
    .prefault({}),
});
export const configSchema = z.strictObject({
  catalog: catalogConfigSchema,
  /** Iceberg namespace holding the `events` table. */
  namespace: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .default("errtraq"),
  engine: engineConfigSchema.prefault({}),
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
  // D3 (owner decision 2026-11-25): format v3 from the start, so row deletes are deletion vectors.
  // Static default (format 3). The runtime store reports `rowDeleteModeFor(config)`, which is
  // `position-delete` when the config selects format 2.
  capabilities: { rowDelete: "deletion-vector" },
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

/** The row delete mode the configured table format version provides (v3 deletion vectors, v2 positional deletes). */
export function rowDeleteModeFor(
  config: Pick<ParsedConfig["engine"], "formatVersion">,
): "deletion-vector" | "position-delete" {
  return config.formatVersion === 3 ? "deletion-vector" : "position-delete";
}

/** The stack selection: `archive: icebergArchive({ catalog: { uri, warehouse }, ... })`. */
export function icebergArchive(config: Config): AdapterSelection<Config> {
  return {
    manifest,
    infra,
    config,
    runtimeModule: "@moriyoshi/errtraq-archive-iceberg",
  };
}
