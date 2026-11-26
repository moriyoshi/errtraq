import { readFile } from "node:fs/promises";
import type { CreateContext } from "@moriyoshi/errtraq-core";
import { Kysely, sql } from "kysely";
import {
  memberTableStatements,
  parseAdminSecret,
  provisionIamUser,
} from "./postgres-admin.js";
import {
  type CloudSqlPoolOptions,
  CLOUDSQL_BINDINGS as CS,
  cloudSqlIamPoolConfig,
  cloudSqlIamUserName,
  cloudSqlTransport,
  parseGrantUsers,
} from "./postgres-cloudsql.js";
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
  // Table-level grants for the other function users, run as the migrating user that owns the tables.
  let members: string[] = [];
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
      undefined,
      { viaProxy: bindings.ERRTRAQ_POSTGRES_VIA_PROXY === "true" },
    );
  } else if (mode === "cloudsql-iam") {
    const text = (name: string) => {
      const value = bindings[name];
      return typeof value === "string" && value ? value : undefined;
    };
    const required = (name: string) => {
      const value = text(name);
      if (!value) throw new Error(`Missing Postgres binding ${name}`);
      return value;
    };
    const instanceConnectionName = required(CS.instance),
      database = required(CS.database);
    // The token source is injected, never fetched here (the Cloud Run platform supplies it
    // from the G0 package, with the Cloud SQL login scope, to verify in G8).
    const accessToken = bindings.accessToken;
    if (typeof accessToken !== "function")
      throw new Error("Cloud SQL IAM requires an access token source");
    const identity = bindings.serviceAccountEmail;
    let user = text(CS.user);
    if (!user) {
      if (typeof identity !== "function")
        throw new Error(`Missing Postgres binding ${CS.user}`);
      try {
        user = cloudSqlIamUserName(await identity());
      } catch {
        throw new Error("Cannot derive the Cloud SQL IAM user");
      }
    }
    const host = text(CS.host);
    const connection: CloudSqlPoolOptions["connection"] = host
      ? {
          kind: "tcp",
          host,
          port: Number(text(CS.port) ?? 5432),
          serverCa: required(CS.serverCa),
          ...(text(CS.serverName) ? { serverName: text(CS.serverName) } : {}),
        }
      : {
          kind: "unix-socket",
          ...(text(CS.socketDir) ? { socketDir: text(CS.socketDir) } : {}),
        };
    if (
      connection.kind === "tcp" &&
      (!Number.isInteger(connection.port) ||
        (connection.port ?? 0) < 1 ||
        (connection.port ?? 0) > 65535)
    )
      throw new Error("Invalid Postgres port");
    const adminSecret = bindings[ADMIN_SECRET_BINDING];
    if (typeof adminSecret === "string" && adminSecret) {
      if (!secretSource)
        throw new Error("Postgres administration requires a secret source");
      const runtimeUser = user;
      // The users of the other functions, from the platform; the migrating user owns the tables.
      members = parseGrantUsers(text(CS.grantUsers)).filter(
        (member) => member !== runtimeUser,
      );
      provision = async () => {
        const transport = cloudSqlTransport({
          instanceConnectionName,
          connection,
        });
        await provisionIamUser({
          host: transport.host ?? "",
          port: transport.port ?? 5432,
          database,
          user: runtimeUser,
          members,
          ssl: transport.ssl,
          flavor: "cloudsql",
          admin: parseAdminSecret(await secretSource.read(adminSecret)),
        });
      };
    }
    dialect = postgresDialect(
      // The shared pool settings keep `max` at 4: a Cloud Run instance may open at most 100
      // Cloud SQL connections, and idle connections close after 10 s, before any token expires.
      cloudSqlIamPoolConfig({
        instanceConnectionName,
        database,
        user,
        accessToken: accessToken as () => Promise<string>,
        connection,
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
          for (const statement of memberTableStatements(members))
            await sql.raw(statement).execute(db);
        }
      : migrate,
    close: () => db.destroy(),
  });
}
