import type {
  ArchiveStore,
  CreateContext,
  SecretSource,
} from "@moriyoshi/errtraq-core";
import type { CatalogAuth } from "./catalog/auth.js";
import {
  IcebergRestCatalog,
  type IcebergRestCatalogOptions,
} from "./catalog/client.js";
import {
  ARCHIVE_CATALOG_URI_BINDING,
  ARCHIVE_REGION_BINDING,
  ARCHIVE_WAREHOUSE_BINDING,
  type Config,
  configSchema,
  type ParsedConfig,
  rowDeleteModeFor,
} from "./stack.js";

/**
 * Apply the environment bindings of the AWS (S3 Tables) descriptor: the module's table bucket ARN,
 * catalog URI and region are the source of truth and override the config's values. Without the
 * bindings (local, Lakekeeper, bring-your-own) the config is returned unchanged.
 */
export function applyEnvironmentBindings(
  config: Config,
  environment: Readonly<Record<string, string | undefined>> | undefined,
): Config {
  const warehouse = environment?.[ARCHIVE_WAREHOUSE_BINDING];
  const uri = environment?.[ARCHIVE_CATALOG_URI_BINDING];
  const region = environment?.[ARCHIVE_REGION_BINDING];
  if (!warehouse && !uri && !region) return config;
  const catalog = { ...config.catalog };
  if (warehouse) catalog.warehouse = warehouse;
  if (uri) catalog.uri = uri;
  if (region && catalog.auth?.type === "sigv4")
    catalog.auth = { ...catalog.auth, region };
  return { ...config, catalog };
}

/** Thrown by every ArchiveStore operation of the main-entry `create` when no engine is bound. */
export class ArchiveEngineNotWiredError extends Error {
  override name = "ArchiveEngineNotWiredError";
  constructor(operation: string) {
    super(
      `archive-iceberg: ${operation} needs a query engine: bind "createEngine" from "@moriyoshi/errtraq-archive-iceberg/duckdb"`,
    );
  }
}

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Set for temporary credentials; the DuckDB engine renews its S3 secret ahead of it. */
  expiration?: Date | string | number;
};
export interface ArchiveIcebergBindings {
  /** Override for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Required for `sigv4` auth. */
  awsCredentials?: () => AwsCredentials | Promise<AwsCredentials>;
  /**
   * The ArchiveStore engine. The main entry never imports DuckDB, so Workers-bound bundles stay
   * clean; Node platforms pass `create` from `@moriyoshi/errtraq-archive-iceberg/duckdb` here.
   */
  createEngine?: (
    context: CreateContext<Config, ArchiveIcebergBindings>,
  ) => ArchiveStore;
}

/** Build the catalog client a stack config describes. */
export function createCatalog(
  parsed: ParsedConfig,
  options: {
    secretSource?: SecretSource | undefined;
    bindings?: ArchiveIcebergBindings;
  } = {},
): IcebergRestCatalog {
  const { catalog } = parsed;
  const { secretSource, bindings = {} } = options;
  const secret = (id: string) => () => {
    if (!secretSource)
      throw new Error("archive-iceberg catalog auth requires a secret source");
    return secretSource.read(id);
  };
  let auth: CatalogAuth;
  switch (catalog.auth.type) {
    case "none":
      auth = { type: "none" };
      break;
    case "bearer":
      auth = { type: "bearer", token: secret(catalog.auth.tokenSecret) };
      break;
    case "oauth2":
      auth = {
        type: "oauth2",
        clientId: catalog.auth.clientId,
        clientSecret: secret(catalog.auth.clientSecretSecret),
        ...(catalog.auth.tokenEndpoint
          ? { tokenEndpoint: catalog.auth.tokenEndpoint }
          : {}),
        ...(catalog.auth.scope ? { scope: catalog.auth.scope } : {}),
      };
      break;
    case "sigv4": {
      const credentials = bindings.awsCredentials;
      if (!credentials)
        throw new Error("archive-iceberg sigv4 auth requires AWS credentials");
      auth = {
        type: "sigv4",
        region: catalog.auth.region,
        credentials,
        ...(catalog.auth.signingName
          ? { signingName: catalog.auth.signingName }
          : {}),
      };
      break;
    }
  }
  const clientOptions: IcebergRestCatalogOptions = {
    uri: catalog.uri,
    auth,
    ...(catalog.warehouse ? { warehouse: catalog.warehouse } : {}),
    ...(catalog.requestTimeoutMs
      ? { requestTimeoutMs: catalog.requestTimeoutMs }
      : {}),
    ...(catalog.ignoreServerUri ? { ignoreServerUri: true } : {}),
    ...(bindings.fetch ? { fetch: bindings.fetch } : {}),
    ...(bindings.now ? { now: bindings.now } : {}),
  };
  return new IcebergRestCatalog(clientOptions);
}

/**
 * The ArchiveStore a stack config describes. Without `bindings.createEngine` every operation
 * rejects with `ArchiveEngineNotWiredError` (the catalog client is still validated).
 */
export function create(
  context: CreateContext<Config, ArchiveIcebergBindings>,
): ArchiveStore {
  const { bindings, secretSource } = context;
  const config = applyEnvironmentBindings(context.config, context.environment);
  const parsed = configSchema.parse(config);
  createCatalog(parsed, { secretSource, bindings });
  if (bindings?.createEngine)
    return bindings.createEngine(
      config === context.config ? context : { ...context, config },
    );
  const fail = (operation: string) => (): Promise<never> =>
    Promise.reject(new ArchiveEngineNotWiredError(operation));
  return {
    append: fail("append"),
    hasBatch: fail("hasBatch"),
    batchEventIds: fail("batchEventIds"),
    query: fail("query"),
    getEvent: fail("getEvent"),
    deleteWhere: fail("deleteWhere"),
    hardErase: fail("hardErase"),
    expireSnapshots: fail("expireSnapshots"),
    deleteOlderThan: fail("deleteOlderThan"),
    deleteProject: fail("deleteProject"),
    capabilities: { rowDelete: rowDeleteModeFor(parsed.engine) },
  };
}
