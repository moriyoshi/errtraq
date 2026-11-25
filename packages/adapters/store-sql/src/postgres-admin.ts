import pg from "pg";

/** The PostgreSQL schema the store's tables live in (the default search path of the user). */
const SCHEMA = "public";

/** Double-quote an identifier; the only character that needs escaping is the quote itself. */
export function quoteIdentifier(name: string): string {
  if (!name || name.includes("\0"))
    throw new Error("Invalid PostgreSQL identifier");
  return `"${name.replaceAll('"', '""')}"`;
}
/** Failure with a fixed message: driver messages can name hosts and users, so none is kept. */
export class PostgresProvisionError extends Error {
  override name = "PostgresProvisionError";
  constructor(readonly code?: string) {
    super("Unable to provision the PostgreSQL IAM user");
  }
}
export interface AdminCredentials {
  username: string;
  password: string;
}
/** Parse the RDS-managed master secret document (`username` and `password`). */
export function parseAdminSecret(raw: string): AdminCredentials {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid PostgreSQL administrator secret");
  }
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const { username, password } = record;
  if (
    typeof username !== "string" ||
    !username ||
    typeof password !== "string" ||
    !password
  )
    throw new Error("Invalid PostgreSQL administrator secret");
  return { username, password };
}
/**
 * Privileges the runtime user needs. It owns what it creates, so it runs migrations itself
 * and later migrations need no further grants; the grants on existing tables cover tables an
 * administrator created earlier (for example by a direct migration run).
 */
export function privilegeStatements(
  user: string,
  database: string,
  flavor: ProvisionFlavor = "rds",
): string[] {
  const role = quoteIdentifier(user);
  return [
    // Cloud SQL makes an IAM user a member of `cloudsqliamuser` when it is created.
    ...(flavor === "rds" ? [`grant rds_iam to ${role}`] : []),
    `grant connect on database ${quoteIdentifier(database)} to ${role}`,
    `grant usage, create on schema ${SCHEMA} to ${role}`,
    `grant all on all tables in schema ${SCHEMA} to ${role}`,
    `grant all on all sequences in schema ${SCHEMA} to ${role}`,
  ];
}
/**
 * `rds`: create the login role and grant `rds_iam`. `cloudsql`: the IAM user is created through
 * the Cloud SQL Admin API (Terraform), `create role` cannot make one, so it must exist already.
 */
export type ProvisionFlavor = "rds" | "cloudsql";
export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}
const DUPLICATE_OBJECT = "42710";
/** Idempotently create the login role and grant it everything the runtime needs. */
export async function ensureIamUser(
  client: Queryable,
  user: string,
  database: string,
  flavor: ProvisionFlavor = "rds",
): Promise<void> {
  const exists = await client.query(
    "select 1 from pg_roles where rolname = $1",
    [user],
  );
  if (!exists.rows.length && flavor === "cloudsql")
    throw Object.assign(new Error("IAM database user is missing"), {
      code: "ROLE_MISSING",
    });
  if (!exists.rows.length)
    try {
      await client.query(`create role ${quoteIdentifier(user)} login`);
    } catch (error) {
      // A concurrent bootstrap created it first.
      if ((error as { code?: unknown }).code !== DUPLICATE_OBJECT) throw error;
    }
  for (const statement of privilegeStatements(user, database, flavor))
    await client.query(statement);
}
function safeCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{4,32}$/.test(code)
    ? code
    : undefined;
}
export interface AdminConnection {
  host: string;
  port: number;
  database: string;
  /** The runtime IAM database user to create. */
  user: string;
  ca?: string;
  /** Overrides the TLS settings derived from `ca`; `false` for a mounted unix socket. */
  ssl?: pg.ClientConfig["ssl"];
  flavor?: ProvisionFlavor;
  admin: AdminCredentials;
  /** Test seam; the default opens a TLS-verified `pg` client. */
  connect?: (
    config: pg.ClientConfig,
  ) => Promise<Queryable & { end(): Promise<void> }>;
}
/** Connect as the administrator over verified TLS, run {@link ensureIamUser}, disconnect. */
export async function provisionIamUser(
  options: AdminConnection,
): Promise<void> {
  const config: pg.ClientConfig = {
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.admin.username,
    password: options.admin.password,
    ssl:
      options.ssl !== undefined
        ? options.ssl
        : {
            ca: options.ca,
            rejectUnauthorized: true,
            servername: options.host,
          },
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  };
  let client: (Queryable & { end(): Promise<void> }) | undefined;
  try {
    client = options.connect
      ? await options.connect(config)
      : await (async () => {
          const real = new pg.Client(config);
          await real.connect();
          return real;
        })();
    await ensureIamUser(client, options.user, options.database, options.flavor);
  } catch (error) {
    throw new PostgresProvisionError(safeCode(error));
  } finally {
    await client?.end().catch(() => undefined);
  }
}
