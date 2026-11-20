import { Kysely } from "kysely";
import type { SqlDatabase } from "./schema.js";
import { sqliteDialect, sqliteStoreDialect } from "./sqlite.js";
import { configSchema, type SqliteConfig } from "./stack.js";
import { createSqlStore } from "./store.js";

export type { SqlStoreDialect } from "./dialect.js";
export { infra, manifest } from "./stack.js";
export type { SqlStoreOptions } from "./store.js";
export { createSqlStore } from "./store.js";

export function create(
  config: SqliteConfig,
  _bindings: Record<string, unknown> = {},
) {
  const parsed = configSchema.parse(config);
  const db: SqlDatabase = new Kysely({ dialect: sqliteDialect(parsed.path) });
  return Object.assign(createSqlStore({ db, dialect: sqliteStoreDialect }), {
    close: () => db.destroy(),
  });
}
