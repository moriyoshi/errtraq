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
// The IAM user of another function: it gets data access, the runtime (migrating) user owns the tables.
const memberUser = env("DRV_MEMBER_USER");
const memberPassword = env("DRV_MEMBER_PASSWORD");
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
await admin.query(`drop role if exists "${memberUser}"`).catch(() => {});
await admin.query(
  `create role "${memberUser}" login password '${memberPassword}'`,
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
    ERRTRAQ_POSTGRES_GRANT_USERS: `${runtimeUser},${memberUser}`,
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

// 2b. The other function's user: data access on the migrated tables, no schema changes.
{
  const member = new pg.Client({
    host: `/cloudsql/${instance}`,
    database,
    user: memberUser,
    password: memberPassword,
  });
  await member.connect();
  const owner = await member.query(
    "select tableowner from pg_tables where schemaname = 'public' and tablename = 'projects'",
  );
  check(
    owner.rows[0]?.tableowner === runtimeUser,
    "the migrating user owns the tables",
  );
  await member.query("select count(*) from projects");
  check(true, "the member user can read the migrated tables");
  const denied = async (statement: string) => {
    try {
      await member.query(statement);
    } catch (error) {
      return (error as { code?: string }).code === "42501";
    }
    return false;
  };
  check(
    await denied("create table member_made (id int)"),
    "the member user cannot create tables",
  );
  check(
    await denied("drop table projects"),
    "the member user cannot drop tables",
  );
  await member.end();
  // A later migration run by the owner: default privileges cover the new table.
  const owned = new pg.Client({
    host: `/cloudsql/${instance}`,
    database,
    user: runtimeUser,
    password: runtimePassword,
  });
  await owned.connect();
  // Default privileges are those the owner set while migrating.
  await owned.query("create table later_table (id int)");
  await owned.end();
  const again = new pg.Client({
    host: `/cloudsql/${instance}`,
    database,
    user: memberUser,
    password: memberPassword,
  });
  await again.connect();
  await again.query("select count(*) from later_table");
  check(true, "tables created by a later migration are readable too");
  await again.end();
}

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
