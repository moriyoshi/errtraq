import type { SqlDatabase } from "./schema.js";

export type SqlValues = Record<string, string | number | null>;
/** SQL engines provide their own conflict syntax and integer-result handling. */
export interface SqlStoreDialect {
  kind: string;
  /** Maximum bind parameters for a single statement. */
  maxParameters: number;
  insertIfAbsent(
    db: SqlDatabase,
    table: string,
    values: SqlValues,
    key?: string,
  ): Promise<boolean>;
  upsert(db: SqlDatabase, table: string, values: SqlValues): Promise<void>;
}
