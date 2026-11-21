import type { SqlDatabase } from "./schema.js";

export type SqlValues = Record<string, string | number | null>;
/** SQL engines provide their own conflict syntax and integer-result handling. */
export interface SqlStoreDialect {
  kind: string;
  /** Maximum bind parameters for a single statement. */
  maxParameters: number;
  /** Schema type for indexed strings, with the dialect's byte-wise collation. */
  keyType: "text" | "integer" | "bigint" | import("kysely").RawBuilder<unknown>;
  jsonType:
    | "text"
    | "integer"
    | "bigint"
    | import("kysely").RawBuilder<unknown>;
  integerType:
    | "text"
    | "integer"
    | "bigint"
    | import("kysely").RawBuilder<unknown>;
  lock(db: SqlDatabase, key: string): Promise<void>;
  didUpdate(count: bigint | undefined): boolean;
  createIndex(
    db: SqlDatabase,
    name: string,
    table: string,
    columns: string[],
    unique?: boolean,
  ): Promise<void>;
  insertIfAbsent(
    db: SqlDatabase,
    table: string,
    values: SqlValues,
    key?: string,
  ): Promise<boolean>;
  upsert(db: SqlDatabase, table: string, values: SqlValues): Promise<void>;
}

/** Both SQLite and Postgres support IF NOT EXISTS; other engines can implement their own DDL. */
export async function createIndexIfAbsent(
  db: SqlDatabase,
  name: string,
  table: string,
  columns: string[],
  unique = false,
): Promise<void> {
  let index = db.schema
    .createIndex(name)
    .ifNotExists()
    .on(table)
    .columns(columns);
  if (unique) index = index.unique();
  await index.execute();
}
