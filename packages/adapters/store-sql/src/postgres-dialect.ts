import { PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { SqlStoreDialect } from "./dialect.js";
import { createIndexIfAbsent } from "./dialect.js";

/** A small pool is reused across warm invocations and can be closed on shutdown. */
export function postgresDialect(
  connectionString: string,
  statementTimeoutMs = 30000,
): PostgresDialect {
  const types = {
    getTypeParser(oid: number, format?: "text" | "binary") {
      if (oid === 20 && format !== "binary")
        return (value: string) => {
          const result = Number(value);
          if (!Number.isSafeInteger(result))
            throw new RangeError("SQL integer exceeds safe range");
          return result;
        };
      return pg.types.getTypeParser(oid, format);
    },
  };
  return new PostgresDialect({
    pool: new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      statement_timeout: statementTimeoutMs,
      idle_in_transaction_session_timeout: 35000,
      types,
    }),
  });
}

export const postgresStoreDialect: SqlStoreDialect = {
  kind: "postgres",
  maxParameters: 1000,
  createIndex: createIndexIfAbsent,
  didUpdate: (count) => count === 1n,
  keyType: sql`varchar(255) collate "C"`,
  jsonType: "text",
  integerType: "bigint",
  async lock(db, key) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(
      db,
    );
  },
  async insertIfAbsent(db, table, values, key = "pk") {
    const result = await db
      .insertInto(table)
      .values(values)
      .onConflict((oc) => oc.column(key).doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0n) === 1;
  },
  async upsert(db, table, values) {
    await db
      .insertInto(table)
      .values(values)
      .onConflict((oc) => oc.column("pk").doUpdateSet(values))
      .execute();
  },
};
