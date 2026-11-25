// Statements and instance options derived from the config. Pure (no DuckDB import) so they can be
// unit-tested as plain strings.
import type { ParsedConfig } from "../stack.js";
import {
  EngineConfigurationError,
  type EngineSettings,
  type S3Credentials,
} from "./session.js";
import { CATALOG_ALIAS, quoteLiteral } from "./sql.js";

export const EXTENSIONS = ["httpfs", "avro", "iceberg"] as const;

/** The DuckDB instance options a config implies (all values are strings in the binding). */
export function instanceOptions(
  engine: EngineSettings,
): Record<string, string> {
  const options: Record<string, string> = {
    // Lambda only lets `/tmp` be written to; DuckDB wants a home for its secret and extension state.
    home_directory: engine.homeDirectory,
  };
  if (engine.extensionDirectory)
    options.extension_directory = engine.extensionDirectory;
  if (engine.memoryLimit) options.memory_limit = engine.memoryLimit;
  if (engine.threads) options.threads = String(engine.threads);
  if (engine.extensionMode === "preinstalled") {
    // Container mode: nothing may reach for the network behind our back.
    options.autoinstall_known_extensions = "false";
    options.autoload_known_extensions = "false";
  }
  return options;
}

/** `CREATE SECRET` for httpfs. Credentials come from the caller, never from DuckDB's own chain. */
export function s3SecretSql(
  engine: EngineSettings,
  region: string,
  credentials: S3Credentials | undefined,
): string {
  const parts = ["TYPE s3", `REGION ${quoteLiteral(region)}`];
  if (credentials) {
    parts.push(
      `KEY_ID ${quoteLiteral(credentials.accessKeyId)}`,
      `SECRET ${quoteLiteral(credentials.secretAccessKey)}`,
    );
    if (credentials.sessionToken)
      parts.push(`SESSION_TOKEN ${quoteLiteral(credentials.sessionToken)}`);
  }
  if (engine.s3.endpoint)
    parts.push(`ENDPOINT ${quoteLiteral(engine.s3.endpoint)}`);
  parts.push(`URL_STYLE ${quoteLiteral(engine.s3.urlStyle)}`);
  parts.push(`USE_SSL ${engine.s3.useSsl ? "true" : "false"}`);
  return `CREATE OR REPLACE SECRET errtraq_s3 (${parts.join(", ")})`;
}

/** The ATTACH statement for the configured catalog type. */
export function attachSql(
  catalog: ParsedConfig["catalog"],
  engine: EngineSettings,
): string {
  if (!catalog.warehouse)
    throw new EngineConfigurationError(
      "archive-iceberg: catalog.warehouse is required by the DuckDB engine",
    );
  const warehouse = quoteLiteral(catalog.warehouse);
  if (engine.catalogType === "s3_tables") {
    if (catalog.auth.type !== "sigv4")
      throw new EngineConfigurationError(
        "archive-iceberg: the s3_tables catalog type requires sigv4 auth",
      );
    return `ATTACH ${warehouse} AS ${CATALOG_ALIAS} (TYPE iceberg, ENDPOINT_TYPE s3_tables)`;
  }
  if (catalog.auth.type !== "none")
    // TODO(M4i): bearer and oauth2 attach through a DuckDB `iceberg` secret; not verified yet.
    throw new EngineConfigurationError(
      `archive-iceberg: the DuckDB engine attaches Lakekeeper without authentication only (auth.type ${catalog.auth.type})`,
    );
  // Static S3 credentials; vended credentials are off (Lakekeeper with sts-enabled false).
  return `ATTACH ${warehouse} AS ${CATALOG_ALIAS} (TYPE iceberg, ENDPOINT ${quoteLiteral(catalog.uri)}, AUTHORIZATION_TYPE 'none', ACCESS_DELEGATION_MODE 'none')`;
}
