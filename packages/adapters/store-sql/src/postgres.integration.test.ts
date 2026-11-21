import { activeStoreContract } from "@errtraq/testing";
import { Kysely, sql } from "kysely";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  postgresDialect,
  postgresStoreDialect,
  rdsIamPoolConfig,
} from "./postgres-dialect.js";
import { createInitialSchema, type SqlDatabase } from "./schema.js";
import { createSqlStore } from "./store.js";

const connection = process.env.ERRTRAQ_TEST_POSTGRES;
const suite = connection ? describe : describe.skip;
suite("Postgres", () => {
  const admin = new pg.Pool({ connectionString: connection });
  const databases: SqlDatabase[] = [];
  const schemas: string[] = [];
  let sequence = 0;
  async function database(schema?: string) {
    const name = schema ?? `test_${process.pid}_${++sequence}`;
    if (!schema) {
      await admin.query(`create schema "${name}"`);
      schemas.push(name);
    }
    if (!connection) throw new Error("Postgres test connection missing");
    const url = new URL(connection);
    url.searchParams.set("options", `-csearch_path=${name}`);
    const db: SqlDatabase = new Kysely({
      dialect: postgresDialect(url.toString()),
    });
    databases.push(db);
    return { db, name };
  }
  afterAll(async () => {
    for (const db of databases) await db.destroy();
    for (const schema of schemas)
      await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  });
  activeStoreContract(async () => {
    const { db } = await database();
    const store = createSqlStore({ db, dialect: postgresStoreDialect });
    await store.migrate();
    return store;
  });
  it("upgrades existing bundle markers without losing active lookups", async () => {
    const { db } = await database();
    await db.schema
      .createTable("schema_version")
      .addColumn("version", "integer", (c) => c.primaryKey())
      .execute();
    await createInitialSchema(db, postgresStoreDialect);
    await db.insertInto("schema_version").values({ version: 1 }).execute();
    const legacy = {
      id: "old",
      projectId: "1",
      releaseId: "release",
      blobKey: "old-blob",
      debugIds: ["debug"],
    };
    const key = JSON.stringify(["1", "old"]);
    await db
      .insertInto("bundles")
      .values({
        pk: key,
        project_id: "1",
        scope: "release",
        data: JSON.stringify(legacy),
      })
      .execute();
    await db
      .insertInto("bundle_debug_ids")
      .values({ project_id: "1", debug_id: "debug", bundle_pk: key })
      .execute();
    const store = createSqlStore({ db, dialect: postgresStoreDialect });
    await store.migrate();
    expect(
      await store.releases.findBundleByDebugId(
        "1" as import("@errtraq/core").ProjectId,
        "debug",
      ),
    ).toMatchObject({
      id: "old",
      state: "active",
      manifest: { blobKey: "old-blob", digest: "legacy", debugIdCount: 1 },
    });
  });
  it("serializes concurrent starters and concurrent writers on separate pools", async () => {
    const { db: a, name } = await database();
    const { db: b } = await database(name);
    const left = createSqlStore({ db: a, dialect: postgresStoreDialect });
    const right = createSqlStore({ db: b, dialect: postgresStoreDialect });
    await Promise.all([left.migrate(), right.migrate()]);
    const receivedAt =
      "2024-01-01T00:00:00.000Z" as import("@errtraq/core").Timestamp;
    const projectId = "1" as import("@errtraq/core").ProjectId;
    const issueId = "i" as import("@errtraq/core").IssueId;
    await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const eventId = `e${i}` as import("@errtraq/core").EventId;
        await (i % 2 ? left : right).recordEvent(
          {
            projectId,
            issueId,
            eventId,
            receivedAt,
            timestamp: receivedAt,
            fingerprint: "fp",
            title: "x",
            culprit: "",
            level: "error",
            type: "error",
            metadata: {},
          },
          {
            projectId,
            issueId,
            eventId,
            receivedAt,
            timestamp: receivedAt,
            level: "error",
            tags: {},
            payload: {},
          },
        );
      }),
    );
    const eventId = "duplicate" as import("@errtraq/core").EventId;
    const occurrence = {
      projectId,
      issueId,
      eventId,
      receivedAt,
      timestamp: receivedAt,
      fingerprint: "fp",
      title: "x",
      culprit: "",
      level: "error" as const,
      type: "error",
      metadata: {},
    };
    const event = {
      projectId,
      issueId,
      eventId,
      receivedAt,
      timestamp: receivedAt,
      level: "error" as const,
      tags: {},
      payload: {},
    };
    const duplicateResults = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? left : right).recordEvent(occurrence, event),
      ),
    );
    expect(duplicateResults.filter((result) => result.inserted)).toHaveLength(
      1,
    );
    expect((await left.issues.get(projectId, issueId))?.count).toBe(41);
    expect(
      (await sql`select count(*) as n from events`.execute(a)).rows[0],
    ).toMatchObject({ n: 41 });
  });
  it("asks the IAM password callback on each new pg connection", async () => {
    if (!connection) throw new Error("Postgres test connection missing");
    const url = new URL(connection);
    const iam = rdsIamPoolConfig({
      host: "db.example.rds.amazonaws.com",
      port: 5432,
      database: "errtraq",
      user: "errtraq",
      region: "us-east-1",
      ca: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
      environment: {
        AWS_ACCESS_KEY_ID: "AKID",
        AWS_SECRET_ACCESS_KEY: "secret",
      },
    });
    if (typeof iam.password !== "function")
      throw new Error("Expected password callback");
    const sign = iam.password;
    const tokens: string[] = [];
    // Local Postgres has no RDS IAM support: generate a token on the real pg callback,
    // then substitute its local password, using the existing local test TLS setting.
    const pool = new pg.Pool({
      ...iam,
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.slice(1),
      ssl: false,
      password: async () => {
        tokens.push(await sign());
        return decodeURIComponent(url.password);
      },
    });
    try {
      const [first, second] = await Promise.all([
        pool.connect(),
        pool.connect(),
      ]);
      first.release();
      second.release();
      expect(tokens).toHaveLength(2);
      expect(tokens.every((token) => token.includes("Action=connect"))).toBe(
        true,
      );
    } finally {
      await pool.end();
    }
  });
  it("releases connections after server-side statement timeouts", async () => {
    if (!connection) throw new Error("Postgres test connection missing");
    const url = new URL(connection);
    const app = `timeout_${process.pid}`;
    url.searchParams.set("application_name", app);
    const db: SqlDatabase = new Kysely({
      dialect: postgresDialect(url.toString(), 100),
    });
    databases.push(db);
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => sql`select pg_sleep(0.3)`.execute(db)),
    );
    expect(attempts.every((result) => result.status === "rejected")).toBe(true);
    expect((await sql`select 1 as n`.execute(db)).rows[0]).toMatchObject({
      n: 1,
    });
    const count = await admin.query(
      "select count(*)::int as n from pg_stat_activity where application_name = $1",
      [app],
    );
    expect(count.rows[0].n).toBeLessThanOrEqual(4);
  });

  it("uses byte order for event ties and the latest-event pointer", async () => {
    const { db } = await database();
    const store = createSqlStore({ db, dialect: postgresStoreDialect });
    await store.migrate();
    const projectId = "1" as import("@errtraq/core").ProjectId;
    const issueId = "i" as import("@errtraq/core").IssueId;
    const receivedAt =
      "2024-01-01T00:00:00.000Z" as import("@errtraq/core").Timestamp;
    for (const id of ["😀", "\uE000"]) {
      const eventId = id as import("@errtraq/core").EventId;
      await store.recordEvent(
        {
          projectId,
          issueId,
          eventId,
          receivedAt,
          timestamp: receivedAt,
          fingerprint: "fp",
          title: "x",
          culprit: "",
          level: "error",
          type: "error",
          metadata: {},
        },
        {
          projectId,
          issueId,
          eventId,
          receivedAt,
          timestamp: receivedAt,
          level: "error",
          tags: {},
          payload: {},
        },
      );
    }
    expect(
      (
        await store.events.listByIssue({ projectId, issueId, order: "asc" })
      ).items.map((item) => item.eventId),
    ).toEqual(["\uE000", "😀"]);
    expect((await store.issues.get(projectId, issueId))?.lastEventId).toBe(
      "😀",
    );
  });

  it("uses ordered indexes for issue, event, erasure and debug lookups", async () => {
    const { db } = await database();
    await createSqlStore({ db, dialect: postgresStoreDialect }).migrate();
    await sql`insert into issues(pk,project_id,issue_id,fingerprint,status,first_seen,last_seen,count,data)
      select 'i' || n, (n % 100)::text, 'issue' || n, 'f' || n,
        case when n % 2 = 0 then 'resolved' else 'unresolved' end,
        '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z', n, '{}'
      from generate_series(1, 20000) n`.execute(db);
    await sql`insert into events(pk,project_id,event_id,issue_id,received_at,user_id,user_email,user_name,user_ip,data)
      select 'e' || n, (n % 100)::text, 'event' || n, 'issue' || (n % 10),
        '2024-01-01T00:00:00.000Z', 'user' || (n % 10), 'email' || (n % 10),
        'name' || (n % 10), 'ip' || (n % 10), '{}' from generate_series(1, 20000) n`.execute(
      db,
    );
    for (const table of [
      "orgs",
      "projects",
      "keys",
      "tokens",
      "releases",
      "bundles",
      "archive_states",
      "erasures",
    ]) {
      await sql
        .raw(
          `insert into ${table}(pk,project_id,lookup,scope,state,data) select 'id' || n, (n % 100)::text, 'lookup' || n, 'scope' || (n % 100), case when n % 2 = 0 then 'received' else 'done' end, '{}' from generate_series(1,20000) n`,
        )
        .execute(db);
    }
    await sql`insert into bundle_debug_ids(project_id,debug_id,bundle_pk)
      select (n % 100)::text, 'debug' || n, 'id' || n from generate_series(1,20000) n`.execute(
      db,
    );
    await sql`analyze`.execute(db);
    const queries = ["select * from issues where issue_id = 'issue1'"];
    for (const sort of ["first_seen", "last_seen", "count"])
      for (const status of [false, true])
        queries.push(
          `select * from issues where project_id = '1' ${status ? "and status = 'resolved'" : ""} order by ${sort} desc, issue_id asc limit 20`,
        );
    for (const direction of ["asc", "desc"])
      queries.push(
        `select * from events where project_id = '1' and issue_id = 'issue1' order by received_at ${direction}, event_id ${direction} limit 20`,
      );
    queries.push(
      "select * from events where project_id = '1' and received_at < '2025' order by received_at, event_id limit 20",
    );
    for (const column of ["user_id", "user_email", "user_name", "user_ip"])
      queries.push(
        `select * from events where project_id = '1' and ${column} = 'x' and received_at <= '2025' order by received_at, event_id limit 20`,
      );
    queries.push(
      "select * from events where pk in ('event-key') and received_at <= '2025'",
    );
    queries.push(
      "select bundles.data from bundle_debug_ids join bundles on bundles.pk = bundle_debug_ids.bundle_pk where bundle_debug_ids.project_id = '1' and bundle_debug_ids.debug_id = 'debug1'",
    );
    queries.push(
      "select * from erasures where state = 'received' order by pk limit 20",
      "select * from erasures where project_id = '1' order by pk limit 20",
      "select * from erasures where project_id = '1' and state = 'received' order by pk limit 20",
    );
    queries.push(
      "select * from orgs where lookup = 'lookup1'",
      "select * from projects where scope = 'scope1' and lookup = 'lookup1'",
      "select * from projects order by pk limit 20",
      "select * from keys where project_id = '1'",
      "select * from keys where lookup = 'lookup1'",
      "select * from tokens where lookup = 'lookup1'",
      "select * from releases where project_id = '1' and lookup = 'lookup1'",
      "select * from releases where project_id = '1' order by pk limit 20",
      "select * from bundles where project_id = '1' and scope = 'scope1' order by pk limit 20",
    );
    for (const table of [
      "orgs",
      "projects",
      "keys",
      "tokens",
      "releases",
      "bundles",
      "archive_states",
      "erasures",
      "issues",
      "events",
    ]) {
      queries.push(`select * from ${table} where pk = 'id1'`);
    }
    for (const query of queries) {
      const result = await sql
        .raw(`explain (format json) ${query}`)
        .execute(db);
      const plan = JSON.stringify(result.rows);
      expect(plan, query).not.toMatch(/Seq Scan|"Node Type":"Sort"/);
      expect(plan, query).toMatch(
        /Index Scan|Index Only Scan|Bitmap Index Scan/,
      );
    }
  }, 30000);
});
