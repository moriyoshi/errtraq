import type { CreateContext } from "@errtraq/core";
import { Kysely } from "kysely";
import { postgresDialect, postgresStoreDialect } from "./postgres-dialect.js";
import type { SqlDatabase } from "./schema.js";
import { createSqlStore } from "./store.js";

export { infra, manifest } from "./postgres-stack.js";

export async function create({ bindings, secretSource }: CreateContext) {
  const identifier = bindings.ERRTRAQ_POSTGRES_SECRET;
  if (typeof identifier !== "string" || !identifier)
    throw new Error("Postgres secret binding is missing");
  if (!secretSource)
    throw new Error(
      "Postgres requires a secret source to resolve its connection string",
    );
  const connectionString = await secretSource.read(identifier);
  const db: SqlDatabase = new Kysely({
    dialect: postgresDialect(connectionString),
  });
  return Object.assign(createSqlStore({ db, dialect: postgresStoreDialect }), {
    close: () => db.destroy(),
  });
}
