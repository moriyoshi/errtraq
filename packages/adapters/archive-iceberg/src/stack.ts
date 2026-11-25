import {
  type AdapterManifest,
  type AdapterSelection,
  type InfraDescriptor,
  type InfraValue,
  out,
  stackValue,
} from "@moriyoshi/errtraq-core";
import { z } from "zod";

/** Environment bindings the AWS descriptor delivers; the runtime lets them override the config. */
export const ARCHIVE_WAREHOUSE_BINDING = "ERRTRAQ_ARCHIVE_WAREHOUSE";
export const ARCHIVE_CATALOG_URI_BINDING = "ERRTRAQ_ARCHIVE_CATALOG_URI";
export const ARCHIVE_REGION_BINDING = "ERRTRAQ_ARCHIVE_REGION";

/**
 * Where the AWS container image bakes the DuckDB extensions (`<dir>/<duckdb version>/<platform>/`),
 * and where the engine loads them from with autoinstall and autoload off (`extensionMode:
 * "preinstalled"`). The CLI image build and `s3TablesArchive` share this one path (D6).
 */
/** DuckDB extensions the engine loads; the image bakes exactly these. */
export const DUCKDB_EXTENSIONS = ["httpfs", "avro", "iceberg"] as const;
export const IMAGE_EXTENSION_DIRECTORY = "/opt/errtraq/duckdb-extensions";
/**
 * DuckDB `memory_limit` of the AWS image functions: the archive function has 1024 MB, a 50k-row
 * batch needed about 440 MB in the Lambda spike, and the default (80 percent) leaves Node too little.
 */
export const IMAGE_MEMORY_LIMIT = "704MB";

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
/**
 * Provisioning knobs of the AWS (S3 Tables) module; ignored by every other deployment. Maintenance
 * values are bounded by the S3 Tables minimums (1 day or 1 hour, 64 MB compaction target).
 */
export const s3TablesProvisioningSchema = z.strictObject({
  /** Customer-managed KMS key for the table bucket; absent selects SSE-S3. */
  kmsKeyArn: z.string().min(1).optional(),
  /** Days before an unreferenced file is marked noncurrent (service default 3). */
  unreferencedDays: z.number().int().min(1).optional(),
  /** Days a noncurrent file is kept before deletion (service default 10). */
  nonCurrentDays: z.number().int().min(1).optional(),
  /** Table-level settings exported by the module for the step that creates the table. */
  compaction: z
    .strictObject({
      targetFileSizeMb: z.number().int().min(64).max(512).optional(),
      strategy: z.enum(["auto", "binpack", "sort", "z-order"]).optional(),
    })
    .optional(),
  snapshots: z
    .strictObject({
      maxAgeHours: z.number().int().min(1).optional(),
      minToKeep: z.number().int().min(1).optional(),
    })
    .optional(),
});
export const configSchema = z.strictObject({
  catalog: catalogConfigSchema,
  /** Read only by the AWS descriptor (`s3TablesArchive`). */
  s3Tables: s3TablesProvisioningSchema.optional(),
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

/**
 * AWS: an S3 Tables table bucket and namespace (`infra/modules/aws/s3tables`). Terraform does not
 * create the `events` table: the engine's `ensureTable` sets the format version, partition spec and
 * sort order, which a Terraform table cannot express. The warehouse (table bucket ARN), catalog URI
 * and region are delivered as environment bindings that override the config at run time.
 * Grants are keyed by capability only; the stack's requirement rows give them to the `archive`
 * role (read, write, delete) and the `api` role (read), both of which run from the container image.
 */
export const infra: InfraDescriptor<Config> = {
  module: {
    provider: "aws",
    component: "s3tables",
    outputs: {
      table_bucket_arn: "string",
      table_bucket_name: "string",
      namespace: "string",
      region: "string",
      catalog_uri: "string",
      table_maintenance: "json-document",
      policies: { map: { map: "json-document" } },
    },
  },
  inputs: (config) => {
    const p = config.s3Tables;
    const inputs: Record<string, InfraValue> = {
      name: stackValue("name"),
      protection: stackValue("protection"),
      tags: stackValue("tags"),
      namespace: config.namespace ?? "errtraq",
    };
    const optional: Record<string, number | string | undefined> = {
      kms_key_arn: p?.kmsKeyArn,
      sse_algorithm: p?.kmsKeyArn ? "aws:kms" : undefined,
      unreferenced_days: p?.unreferencedDays,
      non_current_days: p?.nonCurrentDays,
      compaction_target_file_size_mb: p?.compaction?.targetFileSizeMb,
      compaction_strategy: p?.compaction?.strategy,
      snapshot_max_age_hours: p?.snapshots?.maxAgeHours,
      snapshot_min_to_keep: p?.snapshots?.minToKeep,
    };
    for (const [key, value] of Object.entries(optional))
      if (value !== undefined) inputs[key] = value;
    return inputs;
  },
  resources: { primary: out("table_bucket_arn") },
  capabilities: Object.fromEntries(
    ["read", "write", "delete"].map((capability) => [
      capability,
      { primary: out("policies", capability, "primary") },
    ]),
  ),
  bindings: [
    {
      name: ARCHIVE_WAREHOUSE_BINDING,
      kind: "env",
      purpose: "primary",
      value: out("table_bucket_arn"),
    },
    {
      name: ARCHIVE_CATALOG_URI_BINDING,
      kind: "env",
      purpose: "primary",
      value: out("catalog_uri"),
    },
    {
      name: ARCHIVE_REGION_BINDING,
      kind: "env",
      purpose: "primary",
      value: out("region"),
    },
  ],
};

/** Local or Lakekeeper catalog under the standalone platform, which has no Terraform: nothing is provisioned. */
export const localInfra: InfraDescriptor<Config> = {
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

/**
 * A catalog the operator runs: `archive: icebergArchive({ catalog: { uri, warehouse }, ... })`.
 * Under the standalone platform nothing is provisioned. On AWS pass `existing`, an operator
 * promise that the catalog and its storage exist; it must supply every output the AWS descriptor
 * references (`table_bucket_arn` as the warehouse, `catalog_uri`, `region`, and one IAM policy
 * document per `policies.<read|write|delete>.primary`) and no module is generated.
 */
export function icebergArchive(
  config: Config,
  options: { existing?: Record<string, InfraValue> } = {},
): AdapterSelection<Config> {
  return {
    manifest,
    infra: options.existing ? infra : localInfra,
    config,
    runtimeModule: "@moriyoshi/errtraq-archive-iceberg",
    ...(options.existing ? { existing: options.existing } : {}),
  };
}

export interface S3TablesArchiveOptions {
  /** The AWS region of the stack's provider; the module's `region` output overrides it at run time. */
  region: string;
  namespace?: string;
  /** Provisioning knobs of the table bucket and its maintenance. */
  s3Tables?: z.input<typeof s3TablesProvisioningSchema>;
  engine?: z.input<typeof engineConfigSchema>;
  requestTimeoutMs?: number;
}

/**
 * AWS: provisions the S3 Tables table bucket and namespace and wires the adapter to them
 * (`archive: s3TablesArchive({ region: "us-east-1" })`). SigV4 credentials come from the
 * function role through the platform's `awsCredentials` binding.
 */
export function s3TablesArchive(
  options: S3TablesArchiveOptions,
): AdapterSelection<Config> {
  const config: Config = {
    catalog: {
      uri: `https://s3tables.${options.region}.amazonaws.com/iceberg`,
      auth: { type: "sigv4", region: options.region },
      ...(options.requestTimeoutMs
        ? { requestTimeoutMs: options.requestTimeoutMs }
        : {}),
    },
    ...(options.namespace ? { namespace: options.namespace } : {}),
    ...(options.s3Tables ? { s3Tables: options.s3Tables } : {}),
    // The AWS functions run from the container image (D6): extensions are baked in, never
    // installed at run time, and the two threads the spike measured stay.
    engine: {
      extensionMode: "preinstalled",
      extensionDirectory: IMAGE_EXTENSION_DIRECTORY,
      memoryLimit: IMAGE_MEMORY_LIMIT,
      threads: 2,
      ...options.engine,
      catalogType: "s3_tables",
    },
  };
  return {
    manifest,
    infra,
    config,
    runtimeModule: "@moriyoshi/errtraq-archive-iceberg",
  };
}
