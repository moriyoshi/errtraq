import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  CompiledQuery,
  type DatabaseConnection,
  type SqliteDatabase,
  SqliteDialect,
  type SqliteDialectConfig,
  SqliteDriver,
  type SqliteStatement,
} from "kysely";

class ImmediateDriver extends SqliteDriver {
  override async beginTransaction(
    connection: DatabaseConnection,
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin immediate"));
  }
}
class ImmediateDialect extends SqliteDialect {
  constructor(private readonly sqliteConfig: SqliteDialectConfig) {
    super(sqliteConfig);
  }
  override createDriver(): SqliteDriver {
    return new ImmediateDriver(this.sqliteConfig);
  }
}

/** Adapt Node's synchronous SQLite statements to Kysely's SQLite driver. */
export function sqliteDialect(path: string): SqliteDialect {
  return new ImmediateDialect({
    database: async () => {
      if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
      const db = new DatabaseSync(path);
      db.exec("PRAGMA busy_timeout = 20");
      if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
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
  maxParameters: 900,
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
