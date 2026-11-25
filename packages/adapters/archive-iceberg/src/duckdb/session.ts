// The seam between the store logic and the DuckDB binding. `store.ts` only sees these types, so its
// logic (retry, idempotent append, paging) is testable with a fake session and without the native
// module; `engine.ts` is the one file that imports `@duckdb/node-api`.
import type { ParsedConfig } from "../stack.js";

export type EngineSettings = ParsedConfig["engine"];

/** One DuckDB connection with the iceberg catalog attached. Calls on one session never overlap. */
export interface EngineSession {
  /** Run a statement and return its rows as JSON-compatible objects (BIGINT as strings). */
  all(
    sql: string,
    params?: readonly unknown[],
  ): Promise<Record<string, unknown>[]>;
  /** Run a statement and discard its rows. */
  run(sql: string, params?: readonly unknown[]): Promise<void>;
  close(): void;
}

/** Opens a fresh session (a new DuckDB instance). `ensureTable` uses one of its own. */
export type SessionFactory = () => Promise<EngineSession>;

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export class EngineConfigurationError extends Error {
  override name = "EngineConfigurationError";
}
