import { rateRejectionPipelineSuite } from "@moriyoshi/errtraq-testing";
import { Kysely } from "kysely";
import { afterEach } from "vitest";
import type { SqlDatabase } from "./schema.js";
import { sqliteDialect, sqliteStoreDialect } from "./sqlite.js";
import { createSqlStore } from "./store.js";

const opened: SqlDatabase[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.destroy();
});
rateRejectionPipelineSuite("SQLite", async () => {
  const db: SqlDatabase = new Kysely({ dialect: sqliteDialect(":memory:") });
  opened.push(db);
  const store = createSqlStore({ db, dialect: sqliteStoreDialect });
  await store.migrate();
  return store;
});
