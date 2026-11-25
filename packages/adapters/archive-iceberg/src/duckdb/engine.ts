// The only module that imports `@duckdb/node-api`. Everything reachable from the package's main
// entry and `./catalog` stays free of it; consumers opt in through `./duckdb`.
import { mkdirSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import type { ParsedConfig } from "../stack.js";
import {
  attachSql,
  EXTENSIONS,
  instanceOptions,
  s3SecretSql,
} from "./attach.js";
import { expiryMs, redactCredentials } from "./recovery.js";
import type {
  EngineSession,
  EngineSettings,
  S3Credentials,
} from "./session.js";

export interface OpenSessionOptions {
  catalog: ParsedConfig["catalog"];
  engine: EngineSettings;
  /** Resolved lazily, once per opened session. */
  credentials: () => Promise<S3Credentials | undefined>;
  /** The S3 region, already resolved from the config and the environment. */
  region: string;
}

/** Open a DuckDB instance with the extensions loaded, the S3 secret created and the catalog attached. */
export async function openDuckDbSession(
  options: OpenSessionOptions,
): Promise<EngineSession> {
  const { engine, catalog } = options;
  const attach = attachSql(catalog, engine);
  // DuckDB does not create its home directory (on Lambda `/tmp/...` starts out empty).
  mkdirSync(engine.homeDirectory, { recursive: true });
  if (engine.extensionDirectory && engine.extensionMode === "runtime-install")
    mkdirSync(engine.extensionDirectory, { recursive: true });
  const instance = await DuckDBInstance.create(
    ":memory:",
    instanceOptions(engine),
  );
  const connection = await instance.connect();
  const all: EngineSession["all"] = async (sql, params) => {
    const reader = await connection.runAndReadAll(
      sql,
      params && params.length > 0
        ? ([...params] as Parameters<typeof connection.runAndReadAll>[1])
        : undefined,
    );
    return reader.getRowObjectsJson() as Record<string, unknown>[];
  };
  let expiresAt: number | undefined;
  // Creates (or replaces) the S3 secret from freshly resolved credentials. DuckDB may echo the
  // statement in its error, so a failure is rethrown with the credential values removed.
  const applySecret = async () => {
    const credentials = await options.credentials();
    expiresAt = expiryMs(credentials?.expiration);
    try {
      await all(s3SecretSql(engine, options.region, credentials));
    } catch (error) {
      throw new Error(
        `archive-iceberg: creating the S3 secret failed: ${redactCredentials(
          error instanceof Error ? error.message : String(error),
          credentials,
        )}`,
      );
    }
  };
  const session: EngineSession = {
    all,
    async run(sql, params) {
      await all(sql, params);
    },
    credentialsExpireAt: () => expiresAt,
    refreshCredentials: applySecret,
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
  try {
    if (engine.extensionMode === "runtime-install")
      for (const name of EXTENSIONS) await session.run(`INSTALL ${name}`);
    for (const name of EXTENSIONS) await session.run(`LOAD ${name}`);
    await applySecret();
    await session.run(attach);
    // Without this a session does not see its own commits (S3 Tables spike).
    await session.run("SET iceberg_use_metadata_log = false");
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}
