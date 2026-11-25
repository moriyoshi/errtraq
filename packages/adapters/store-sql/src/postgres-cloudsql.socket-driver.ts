/**
 * Opt-in driver (run by `scripts/test-postgres-cloudsql.mjs`, bundled and executed in a
 * container that shares the Postgres unix socket directory; never part of `pnpm test`).
 * Postgres with password authentication stands in for Cloud SQL IAM: the "token" is the
 * database password of a user shaped like an IAM service account user.
 */
import pg from "pg";
import { create } from "./postgres.js";
import { cloudSqlIamPoolConfig } from "./postgres-cloudsql.js";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const instance = env("DRV_INSTANCE");
const database = env("DRV_DATABASE");
const adminUser = env("DRV_ADMIN_USER");
const adminPassword = env("DRV_ADMIN_PASSWORD");
const runtimeUser = env("DRV_RUNTIME_USER");
const runtimePassword = env("DRV_RUNTIME_PASSWORD");
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
};

// The IAM user is created out of band (Terraform on Cloud SQL).
const admin = new pg.Client({
  host: `/cloudsql/${instance}`,
  database,
  user: adminUser,
  password: adminPassword,
});
await admin.connect();
await admin.query(`drop role if exists "${runtimeUser}"`).catch(() => {});
await admin.query(
  `create role "${runtimeUser}" login password '${runtimePassword}'`,
);
await admin.end();

const base = {
  ERRTRAQ_POSTGRES_INSTANCE: instance,
  ERRTRAQ_POSTGRES_DATABASE: database,
  ERRTRAQ_POSTGRES_USER: runtimeUser,
};

// 1. Wrong token: the password callback is used, the server refuses.
const refused = await create({
  config: { mode: "cloudsql-iam" },
  bindings: { ...base, accessToken: async () => "not-the-token" },
  dependencies: {},
});
let failure: unknown;
try {
  await refused.migrate();
} catch (error) {
  failure = error;
}
await refused.close();
check(
  (failure as { code?: string } | undefined)?.code === "28P01",
  "a wrong token is refused by the server over the socket",
);

// 2. Bootstrap path: the admin secret grants privileges, then the runtime user migrates.
let tokens = 0;
const secrets: Record<string, string> = {
  "admin-secret": JSON.stringify({
    username: adminUser,
    password: adminPassword,
  }),
};
const store = await create({
  config: { mode: "cloudsql-iam" },
  bindings: {
    ...base,
    ERRTRAQ_POSTGRES_ADMIN_SECRET: "admin-secret",
    accessToken: async () => {
      tokens++;
      return runtimePassword;
    },
  },
  dependencies: {},
  secretSource: { read: async (id: string) => secrets[id] ?? "" },
});
await store.migrate();
check(
  tokens >= 1,
  "the password callback supplied the token for new connections",
);
const before = tokens;
await Promise.all(Array.from({ length: 6 }, () => store.projects.list()));
check(tokens >= before, "queries through the pool keep working");
await store.close();

// 3. The pool configuration alone, with a connection per call: a token per connection.
let calls = 0;
const config = cloudSqlIamPoolConfig({
  instanceConnectionName: instance,
  database,
  user: runtimeUser,
  accessToken: async () => {
    calls++;
    return runtimePassword;
  },
  connection: { kind: "unix-socket" },
});
for (let i = 0; i < 3; i++) {
  const client = new pg.Client(config);
  await client.connect();
  await client.query("select 1");
  await client.end();
}
check(calls === 3, "each new connection asks for a fresh token");

// 4. A runtime user that was never created is a clear provisioning failure.
const missing = await create({
  config: { mode: "cloudsql-iam" },
  bindings: {
    ...base,
    ERRTRAQ_POSTGRES_USER: "missing@proj.iam",
    ERRTRAQ_POSTGRES_ADMIN_SECRET: "admin-secret",
    accessToken: async () => "x",
  },
  dependencies: {},
  secretSource: { read: async (id: string) => secrets[id] ?? "" },
});
let provisionFailure: unknown;
try {
  await missing.migrate();
} catch (error) {
  provisionFailure = error;
}
await missing.close();
check(
  (provisionFailure as { code?: string } | undefined)?.code === "ROLE_MISSING",
  "provisioning a user Terraform did not create fails clearly",
);
console.log("DONE");
