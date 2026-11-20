import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { activeStoreContract } from "@errtraq/testing";
import { Kysely, sql } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { create } from "./index.js";
import { migrate, type SqlDatabase } from "./schema.js";
import { sqliteDialect, sqliteStoreDialect } from "./sqlite.js";
import { createSqlStore } from "./store.js";

const root = join(process.cwd(), ".agents-workspace", "tmp");
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, "m1a-sql-"));
const opened: SqlDatabase[] = [];
function database(path: string): SqlDatabase {
  const db: SqlDatabase = new Kysely({ dialect: sqliteDialect(path) });
  opened.push(db);
  return db;
}
afterEach(async () => {
  for (const db of opened.splice(0)) await db.destroy();
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let sequence = 0;
for (const kind of ["memory", "file"] as const) {
  describe(`SQLite ${kind}`, () => {
    activeStoreContract(async () => {
      const db = database(
        kind === "memory" ? ":memory:" : join(directory, `${++sequence}.db`),
      );
      const store = createSqlStore({ db, dialect: sqliteStoreDialect });
      await store.migrate();
      return store;
    });
  });
}
describe("SQLite migrations and indexes", () => {
  it("closes created adapters before and after initialization", async () => {
    const unused = create({ path: ":memory:" });
    await unused.close();
    const store = create({ path: ":memory:" });
    await store.migrate();
    await store.close();
  });
  it("migrates a fresh database and can rerun", async () => {
    const db = database(":memory:");
    await migrate(db, sqliteStoreDialect);
    await migrate(db, sqliteStoreDialect);
    const rows = await db.selectFrom("schema_version").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
  });
  it("uses indexes for issue and event access patterns", async () => {
    const db = database(":memory:");
    await migrate(db, sqliteStoreDialect);
    const queries = [
      sql`explain query plan select * from issues where project_id = ${"1"} order by last_seen desc, issue_id asc limit 20`,
      sql`explain query plan select * from events where project_id = ${"1"} and issue_id = ${"i"} order by received_at, event_id limit 20`,
      sql`explain query plan select * from events where project_id = ${"1"} and received_at < ${"2024"} order by received_at, event_id limit 20`,
      sql`explain query plan select * from events where project_id = ${"1"} and user_email = ${"x"} and received_at <= ${"2024"} order by received_at, event_id limit 20`,
    ];
    for (const query of queries) {
      const result = await query.execute(db);
      expect(result.rows.map((row) => JSON.stringify(row)).join(" ")).toMatch(
        /USING INDEX/,
      );
    }
  });
});
