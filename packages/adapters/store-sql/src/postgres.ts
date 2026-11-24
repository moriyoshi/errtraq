import { readFile } from "node:fs/promises";
import type { CreateContext } from "@moriyoshi/errtraq-core";
import { Kysely } from "kysely";
import { parseAdminSecret, provisionIamUser } from "./postgres-admin.js";
import {
  postgresDialect,
  postgresStoreDialect,
  rdsIamPoolConfig,
} from "./postgres-dialect.js";
import { ADMIN_SECRET_BINDING } from "./postgres-stack.js";
import type { SqlDatabase } from "./schema.js";
import { createSqlStore } from "./store.js";

export { infra, manifest } from "./postgres-stack.js";

export async function create({
  config,
  bindings,
  secretSource,
  environment,
}: CreateContext) {
  const mode =
    config && typeof config === "object" && "mode" in config
      ? config.mode
      : undefined;
  let dialect: ReturnType<typeof postgresDialect>;
  let provision: (() => Promise<void>) | undefined;
  if (mode === "iam") {
    const required = (name: string) => {
      const value = bindings[name];
      if (typeof value !== "string" || !value)
        throw new Error(`Missing Postgres binding ${name}`);
      return value;
    };
    const host = required("ERRTRAQ_POSTGRES_HOST"),
      port = Number(required("ERRTRAQ_POSTGRES_PORT"));
    const database = required("ERRTRAQ_POSTGRES_DATABASE"),
      user = required("ERRTRAQ_POSTGRES_USER");
    const region = required("ERRTRAQ_POSTGRES_REGION"),
      path = required("ERRTRAQ_POSTGRES_CA_PATH");
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid Postgres port");
    let ca: string;
    try {
      ca = await readFile(path, "utf8");
    } catch {
      throw new Error("Cannot read RDS CA bundle");
    }
    // Only the bootstrap role is delivered the administrator secret; every other role connects
    // as the IAM user alone.
    const adminSecret = bindings[ADMIN_SECRET_BINDING];
    if (typeof adminSecret === "string" && adminSecret) {
      if (!secretSource)
        throw new Error("Postgres administration requires a secret source");
      provision = async () =>
        provisionIamUser({
          host,
          port,
          database,
          user,
          ca,
          admin: parseAdminSecret(await secretSource.read(adminSecret)),
        });
    }
    dialect = postgresDialect(
      rdsIamPoolConfig({
        host,
        port,
        database,
        user,
        region,
        ca,
        environment: environment ?? process.env,
      }),
    );
  } else if (
    mode === "secret" ||
    (mode === undefined &&
      config !== null &&
      typeof config === "object" &&
      Object.keys(config).length === 0)
  ) {
    const identifier = bindings.ERRTRAQ_POSTGRES_SECRET;
    if (typeof identifier !== "string" || !identifier)
      throw new Error("Postgres secret binding is missing");
    if (!secretSource)
      throw new Error(
        "Postgres requires a secret source to resolve its connection string",
      );
    dialect = postgresDialect(await secretSource.read(identifier));
  } else throw new Error("Invalid Postgres authentication mode");
  const db: SqlDatabase = new Kysely({ dialect });
  const store = createSqlStore({ db, dialect: postgresStoreDialect });
  const migrate = store.migrate;
  return Object.assign(store, {
    // With administrator credentials, migration first makes sure the IAM user exists with the
    // privileges to create and own the schema, then migrates as that user.
    migrate: provision
      ? async () => {
          await provision();
          await migrate();
        }
      : migrate,
    close: () => db.destroy(),
  });
}
