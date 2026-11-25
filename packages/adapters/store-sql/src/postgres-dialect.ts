import { signRdsAuthToken } from "@moriyoshi/errtraq-aws-signing";
import { PostgresDialect, sql } from "kysely";
import pg from "pg";
import type { SqlStoreDialect } from "./dialect.js";
import { createIndexIfAbsent } from "./dialect.js";

/**
 * Pool settings. Through RDS Proxy, server-side session timeouts cannot be sent as startup
 * options (the proxy refuses `statement_timeout`) and a per-session `SET` would pin the proxy
 * connection, so the statement bound becomes pg's client-side `query_timeout`.
 */
export function postgresPoolConfig(
  connectionString: string | pg.PoolConfig,
  statementTimeoutMs = 30000,
  options: { viaProxy?: boolean } = {},
): pg.PoolConfig {
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
  return {
    ...(typeof connectionString === "string"
      ? { connectionString }
      : connectionString),
    max: 4,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    ...(options.viaProxy
      ? { query_timeout: statementTimeoutMs }
      : {
          statement_timeout: statementTimeoutMs,
          idle_in_transaction_session_timeout: 35000,
        }),
    types,
  };
}

/** A small pool is reused across warm invocations and can be closed on shutdown. */
export function postgresDialect(
  connectionString: string | pg.PoolConfig,
  statementTimeoutMs = 30000,
  options: { viaProxy?: boolean } = {},
): PostgresDialect {
  return new PostgresDialect({
    pool: new pg.Pool(
      postgresPoolConfig(connectionString, statementTimeoutMs, options),
    ),
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

/** A fresh token and fresh Lambda credentials are obtained for each new TCP connection. */
export function rdsIamPoolConfig(options: {
  host: string;
  port: number;
  database: string;
  user: string;
  region: string;
  ca: string;
  environment: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}): pg.PoolConfig {
  if (!options.ca.includes("-----BEGIN CERTIFICATE-----"))
    throw new Error("Invalid RDS CA bundle");
  return {
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    ssl: { ca: options.ca, rejectUnauthorized: true, servername: options.host },
    password: async () => {
      const date = (options.now ?? (() => new Date()))();
      const datetime = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
      return signRdsAuthToken({
        host: options.host,
        port: options.port,
        user: options.user,
        region: options.region,
        datetime,
        credentials: {
          accessKeyId: options.environment.AWS_ACCESS_KEY_ID ?? "",
          secretAccessKey: options.environment.AWS_SECRET_ACCESS_KEY ?? "",
          sessionToken: options.environment.AWS_SESSION_TOKEN,
        },
      });
    },
  };
}
