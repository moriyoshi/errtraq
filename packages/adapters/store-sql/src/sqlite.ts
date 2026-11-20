import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  type SqliteDatabase,
  SqliteDialect,
  type SqliteStatement,
} from "kysely";

/** Adapt Node's synchronous SQLite statements to Kysely's SQLite driver. */
export function sqliteDialect(path: string): SqliteDialect {
  return new SqliteDialect({
    database: async () => {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA busy_timeout = 5000");
      if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
      const database: SqliteDatabase = {
        close: () => db.close(),
        prepare(sql): SqliteStatement {
          const stmt = db.prepare(sql);
          return {
            reader:
              /^\s*(?:select|pragma|explain|with)\b/i.test(sql) ||
              /\breturning\b/i.test(sql),
            all(parameters) {
              return stmt.all(...(parameters as SQLInputValue[])) as unknown[];
            },
            run(parameters) {
              const result = stmt.run(...(parameters as SQLInputValue[]));
              return {
                changes: Number(result.changes),
                lastInsertRowid: Number(result.lastInsertRowid),
              };
            },
            *iterate(parameters) {
              yield* stmt.iterate(...(parameters as SQLInputValue[]));
            },
          };
        },
      };
      return database;
    },
  });
}

/** SQLite's conflict syntax; other engines provide their own implementation. */
export const sqliteStoreDialect: import("./dialect.js").SqlStoreDialect = {
  kind: "sqlite",
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
