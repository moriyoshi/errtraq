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
import { type Config, configSchema, type ParsedConfig } from "./stack.js";

/** Thrown by every ArchiveStore operation until the DuckDB engine lands. */
export class ArchiveEngineNotWiredError extends Error {
  override name = "ArchiveEngineNotWiredError";
  constructor(operation: string) {
    super(
      `archive-iceberg: ${operation} needs the query engine, which is not wired yet (TODO(M4f))`,
    );
  }
}

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
export interface ArchiveIcebergBindings {
  /** Override for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Required for `sigv4` auth. */
  awsCredentials?: () => AwsCredentials | Promise<AwsCredentials>;
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
    ...(bindings.fetch ? { fetch: bindings.fetch } : {}),
    ...(bindings.now ? { now: bindings.now } : {}),
  };
  return new IcebergRestCatalog(clientOptions);
}

/** TODO(M4f): replace with the DuckDB-backed engine; the catalog client is already usable. */
export function create({
  config,
  bindings,
  secretSource,
}: CreateContext<Config, ArchiveIcebergBindings>): ArchiveStore {
  const parsed = configSchema.parse(config);
  createCatalog(parsed, { secretSource, bindings });
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
    capabilities: { rowDelete: "deletion-vector" },
  };
}
