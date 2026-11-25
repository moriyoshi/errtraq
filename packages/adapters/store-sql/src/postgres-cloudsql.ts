import {
  type Binding,
  type EnvRef,
  type InfraDescriptor,
  isEnvRef,
  isVariableRef,
  out,
  type VariableRef,
} from "@moriyoshi/errtraq-core";
import type pg from "pg";
import { z } from "zod";

/**
 * Cloud SQL for PostgreSQL with IAM database authentication. Everything specific to the
 * transport (D9) and to the token source (G0) is in this file so a different answer is local.
 *
 * Facts, from the Cloud SQL documentation fetched 2026-11-26 (see GCP_PLAN section 9):
 * - the database user of a service account is its email without the `.gserviceaccount.com`
 *   suffix (IAM database authentication page, "Add an IAM user" page);
 * - the password is an OAuth 2.0 access token of that identity (IAM database authentication);
 * - Cloud Run mounts the instance at `/cloudsql/INSTANCE_CONNECTION_NAME`, the PostgreSQL socket
 *   file is `.s.PGSQL.5432` inside it, the socket is encrypted by the platform without client
 *   TLS, and socket paths over 108 characters cannot connect (Cloud Run to Cloud SQL page);
 * - a private IP connection is plain TCP to the instance (no proxy), so the client verifies the
 *   server certificate itself; a per-instance CA identifies the instance by itself, shared and
 *   customer-managed CAs need the DNS name checked too (server certificate page).
 */

/** The OAuth scope of the login token. Not stated on the pages above; this is the scope the Cloud SQL connectors and `gcloud sql generate-login-token` use (to confirm in G8). */
export const CLOUD_SQL_LOGIN_SCOPE =
  "https://www.googleapis.com/auth/sqlservice.login";
export const DEFAULT_SOCKET_DIR = "/cloudsql";
const SOCKET_FILE = ".s.PGSQL.5432";
const MAX_SOCKET_PATH = 107; // sockaddr_un limit of 108 including the terminator

const stringRef = z.custom<VariableRef | EnvRef>(
  (v) =>
    isVariableRef(v) ||
    (isEnvRef(v) && v.phase === "runtime" && v.valueType === undefined),
);
const instanceConnectionName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*(:[A-Za-z0-9][A-Za-z0-9-]*){2,3}$/);
const serviceAccountEmail = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9.-]+\.gserviceaccount\.com$/);

/** The database user of a service account: the email without `.gserviceaccount.com`. */
export function cloudSqlIamUserName(email: string): string {
  if (!serviceAccountEmail.safeParse(email).success)
    throw new Error("Invalid service account email");
  return email.slice(0, -".gserviceaccount.com".length);
}

const unixSocket = z.strictObject({
  kind: z.literal("unix-socket"),
  /** Where the platform mounts instances; Cloud Run uses `/cloudsql`. */
  socketDir: z
    .string()
    .regex(/^\/[A-Za-z0-9_./-]*$/)
    .refine((v) => !v.includes(".."))
    .default(DEFAULT_SOCKET_DIR),
});
const tcp = z.strictObject({
  kind: z.literal("tcp"),
  /** Private IP (or a DNS name) of the instance. */
  host: z
    .string()
    .regex(/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/)
    .refine((v) => !v.includes("..")),
  port: z.number().int().min(1).max(65535).default(5432),
  /** PEM of the instance's server CA (`serverCaCert.cert`); public data, carried inline. */
  serverCa: z.union([z.string().min(1), stringRef]),
  /**
   * The DNS name the server certificate carries, to check the hostname as well. Required for
   * shared and customer-managed server CAs; leave unset only with a per-instance CA, where
   * trusting that one CA identifies the instance (the certificate does not name the IP).
   */
  serverName: z
    .string()
    .regex(/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/)
    .optional(),
});
export const connectionSchema = z.discriminatedUnion("kind", [unixSocket, tcp]);
export type CloudSqlConnection = z.infer<typeof connectionSchema>;

export const cloudSqlIamSchema = z.strictObject({
  mode: z.literal("cloudsql-iam"),
  /** `project:region:instance` (a domain-scoped project adds a fourth part). */
  instanceConnectionName,
  /** Explicit, as everywhere: the region of the instance. */
  region: z.string().regex(/^[a-z]+(-[a-z]+)?[0-9]+(-[a-z0-9]+)*$/),
  database: z.string().min(1),
  /**
   * The service account the functions run as. Its database user is derived from it. When
   * omitted, each runtime derives its own user from its own identity (one user per function
   * service account); then the SQL grants must exist for each of them.
   */
  serviceAccountEmail: serviceAccountEmail.optional(),
  connection: connectionSchema.default({
    kind: "unix-socket",
    socketDir: DEFAULT_SOCKET_DIR,
  }),
  /** Secret Manager secret holding `{ "username", "password" }` of a built-in `cloudsqlsuperuser` user, for the bootstrap role only. */
  adminSecret: z.custom<VariableRef>(isVariableRef).optional(),
});
export type CloudSqlIamConfig = z.input<typeof cloudSqlIamSchema>;
/** What a runtime function receives as plain configuration (no admin secret, no CA text). */
export const cloudSqlRuntimeSchema = cloudSqlIamSchema.omit({
  adminSecret: true,
  connection: true,
  serviceAccountEmail: true,
});
export type CloudSqlRuntimeConfig = z.infer<typeof cloudSqlRuntimeSchema>;

export const CLOUDSQL_BINDINGS = {
  instance: "ERRTRAQ_POSTGRES_INSTANCE",
  database: "ERRTRAQ_POSTGRES_DATABASE",
  user: "ERRTRAQ_POSTGRES_USER",
  socketDir: "ERRTRAQ_POSTGRES_SOCKET_DIR",
  host: "ERRTRAQ_POSTGRES_HOST",
  port: "ERRTRAQ_POSTGRES_PORT",
  serverCa: "ERRTRAQ_POSTGRES_SERVER_CA",
  serverName: "ERRTRAQ_POSTGRES_SERVER_NAME",
} as const;

export interface CloudSqlPoolOptions {
  instanceConnectionName: string;
  database: string;
  user: string;
  /**
   * Supplies a fresh login token. G0's token source caches with an expiry skew and is called
   * once per new connection; a token only matters at login, established connections outlive it.
   * The Cloud Run platform wires `@moriyoshi/errtraq-gcp-auth` here (scope `sqlservice.login`).
   */
  accessToken: () => Promise<string>;
  connection:
    | { kind: "unix-socket"; socketDir?: string }
    | {
        kind: "tcp";
        host: string;
        port?: number;
        serverCa: string;
        serverName?: string;
      };
}

/** Failure with a fixed message: token errors can carry credential text. */
export class CloudSqlTokenError extends Error {
  override name = "CloudSqlTokenError";
  constructor() {
    super("Unable to obtain a Cloud SQL login token");
  }
}

/** The transport: a mounted unix socket without TLS, or verified TLS to a private IP. */
export function cloudSqlTransport(
  options: Pick<CloudSqlPoolOptions, "instanceConnectionName" | "connection">,
): Pick<pg.PoolConfig, "host" | "port" | "ssl"> {
  const connection = options.connection;
  if (connection.kind === "unix-socket") {
    const dir = `${(connection.socketDir ?? DEFAULT_SOCKET_DIR).replace(/\/+$/, "")}/${options.instanceConnectionName}`;
    if (`${dir}/${SOCKET_FILE}`.length > MAX_SOCKET_PATH)
      throw new Error("Cloud SQL socket path exceeds the 108 character limit");
    // pg appends `/.s.PGSQL.<port>` to a host that is a directory.
    return { host: dir, port: 5432, ssl: false };
  }
  if (!connection.serverCa.includes("-----BEGIN CERTIFICATE-----"))
    throw new Error("Invalid Cloud SQL server CA");
  return {
    host: connection.host,
    port: connection.port ?? 5432,
    ssl: {
      ca: connection.serverCa,
      rejectUnauthorized: true,
      ...(connection.serverName
        ? { servername: connection.serverName }
        : {
            // Chain verification against the one pinned per-instance CA remains in force; only
            // the hostname comparison is skipped, because the certificate does not name the IP.
            checkServerIdentity: () => undefined,
          }),
    },
  };
}

/** A fresh token is asked for on each new connection. */
export function cloudSqlIamPoolConfig(
  options: CloudSqlPoolOptions,
): pg.PoolConfig {
  return {
    ...cloudSqlTransport(options),
    database: options.database,
    user: options.user,
    password: async () => {
      let token: string;
      try {
        token = await options.accessToken();
      } catch {
        throw new CloudSqlTokenError();
      }
      if (typeof token !== "string" || !token) throw new CloudSqlTokenError();
      return token;
    },
  };
}

/**
 * Infra for the selection: an IAM binding document module (`roles/cloudsql.instanceUser` for the
 * login, `roles/cloudsql.client` where the proxy socket is used), per capability like RDS.
 * TODO(G6): `infra/modules/google/cloudsql-iam-access` is not written; until then, pass `existing`
 * policies (`policies.<read|write|delete>.primary`) or expect validation to name the gap.
 */
export function cloudSqlInfra(
  config: z.output<typeof cloudSqlIamSchema>,
  bindings: Binding[],
): InfraDescriptor<CloudSqlRuntimeConfig> {
  return {
    module: {
      provider: "google",
      component: "cloudsql-iam-access",
      outputs: { policies: { map: { map: "json-document" } } },
    },
    inputs: () => ({
      instance_connection_name: config.instanceConnectionName,
      region: config.region,
      ...(config.serviceAccountEmail
        ? { database_user: cloudSqlIamUserName(config.serviceAccountEmail) }
        : {}),
      transport: config.connection.kind,
    }),
    resources: { primary: "external" },
    capabilities: {
      "key-read": { primary: out("policies", "read", "primary") },
      "project-read": { primary: out("policies", "read", "primary") },
      "release-read": { primary: out("policies", "read", "primary") },
      read: { primary: out("policies", "read", "primary") },
      write: { primary: out("policies", "write", "primary") },
      delete: { primary: out("policies", "delete", "primary") },
      "metadata-delete": { primary: out("policies", "write", "primary") },
      ...(config.adminSecret ? { admin: { primary: null } } : {}),
    },
    bindings,
  };
}

/** Environment bindings of a validated selection. */
export function cloudSqlEnvBindings(
  config: z.output<typeof cloudSqlIamSchema>,
): Binding[] {
  const b = CLOUDSQL_BINDINGS;
  const connection = config.connection;
  const env = (name: string, value: Binding["value"]): Binding => ({
    name,
    kind: "env",
    purpose: "primary",
    value,
  });
  return [
    env(b.instance, config.instanceConnectionName),
    env(b.database, config.database),
    ...(config.serviceAccountEmail
      ? [env(b.user, cloudSqlIamUserName(config.serviceAccountEmail))]
      : []),
    ...(connection.kind === "unix-socket"
      ? [env(b.socketDir, connection.socketDir)]
      : [
          env(b.host, connection.host),
          env(b.port, String(connection.port)),
          env(b.serverCa, connection.serverCa),
          ...(connection.serverName
            ? [env(b.serverName, connection.serverName)]
            : []),
        ]),
  ];
}
