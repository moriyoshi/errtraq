import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type ApiTokenId,
  bootstrapProject,
  type OrgId,
  type Timestamp,
  WebCryptoIdGen,
} from "@moriyoshi/errtraq-core";
import {
  activeStoreContract,
  archivalSuite,
  FakeClock,
  federationSuite,
  housekeepingSuite,
  MemoryKV,
} from "@moriyoshi/errtraq-testing";
import { Kysely, sql } from "kysely";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { create as createAdapter } from "./index.js";

const create = (
  config: Parameters<typeof createAdapter>[0]["config"] = {} as Parameters<
    typeof createAdapter
  >[0]["config"],
  bindings: Parameters<typeof createAdapter>[0]["bindings"] = {},
) => createAdapter({ config, bindings, dependencies: {}, topics: {} });

import { createInitialSchema, migrate, type SqlDatabase } from "./schema.js";
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
    federationSuite(async () => {
      const db = database(
        kind === "memory" ? ":memory:" : join(directory, `${++sequence}.db`),
      );
      const store = createSqlStore({ db, dialect: sqliteStoreDialect });
      await store.migrate();
      return store;
    });
    archivalSuite(async () => {
      const db = database(
        kind === "memory" ? ":memory:" : join(directory, `${++sequence}.db`),
      );
      const store = createSqlStore({ db, dialect: sqliteStoreDialect });
      await store.migrate();
      return store;
    });
    housekeepingSuite(async () => {
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
  it("rolls back the entire record group if a later event write fails", async () => {
    const db = database(":memory:");
    let issueWrites = 0;
    const dialect = {
      ...sqliteStoreDialect,
      async upsert(...args: Parameters<typeof sqliteStoreDialect.upsert>) {
        if (args[1] === "issues" && ++issueWrites === 2)
          throw new Error("injected group failure");
        return sqliteStoreDialect.upsert(...args);
      },
    };
    const store = createSqlStore({ db, dialect });
    await store.migrate();
    const projectId = "1" as import("@moriyoshi/errtraq-core").ProjectId;
    const issueId = "issue" as import("@moriyoshi/errtraq-core").IssueId;
    const time =
      "2025-01-01T00:00:00.000Z" as import("@moriyoshi/errtraq-core").Timestamp;
    const group = ["first", "second"].map((id) => {
      const eventId = id as import("@moriyoshi/errtraq-core").EventId;
      const common = {
        projectId,
        issueId,
        eventId,
        timestamp: time,
        receivedAt: time,
      };
      return {
        occurrence: {
          ...common,
          fingerprint: "fp",
          title: "title",
          culprit: "",
          level: "error" as const,
          type: "error",
          metadata: {},
        },
        event: { ...common, level: "error" as const, tags: {}, payload: {} },
      };
    });
    await expect(store.recordEvents(group)).rejects.toThrow(
      "injected group failure",
    );
    expect(
      await store.events.get(
        projectId,
        group[0]?.event.eventId as import("@moriyoshi/errtraq-core").EventId,
      ),
    ).toBeNull();
    expect(await store.issues.get(projectId, issueId)).toBeNull();
  });
  it("creates a missing database parent directory when initialized", async () => {
    const store = create({
      path: join(directory, "nested", "data", "events.sqlite"),
    });
    try {
      await expect(store.migrate()).resolves.toBeUndefined();
    } finally {
      await store.close();
    }
  });
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
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5]);
  });
  it("upgrades version one and rejects newer schemas", async () => {
    const db = database(":memory:");
    await db.schema
      .createTable("schema_version")
      .addColumn("version", "integer", (c) => c.primaryKey())
      .execute();
    await createInitialSchema(db);
    await db.insertInto("schema_version").values({ version: 1 }).execute();
    await migrate(db, sqliteStoreDialect);
    expect(
      (
        await db
          .selectFrom("schema_version")
          .select("version")
          .orderBy("version")
          .execute()
      ).map((r) => r.version),
    ).toEqual([1, 2, 3, 4, 5]);
    await db.insertInto("schema_version").values({ version: 7 }).execute();
    await expect(migrate(db, sqliteStoreDialect)).rejects.toMatchObject({
      name: "UnsupportedSchemaVersionError",
    });
  });
  it("backfills the organization scope so pre-index tokens stay listable and revocable", async () => {
    const db = database(":memory:");
    await db.schema
      .createTable("schema_version")
      .addColumn("version", "integer", (c) => c.primaryKey())
      .execute();
    await createInitialSchema(db, sqliteStoreDialect);
    await db.insertInto("schema_version").values({ version: 1 }).execute();
    const legacy = {
      id: "old-token",
      orgId: "org-1",
      tokenHash: "legacy-hash",
      scopes: ["event:read"],
    };
    await db
      .insertInto("tokens")
      .values({
        pk: legacy.id,
        lookup: legacy.tokenHash,
        data: JSON.stringify(legacy),
      })
      .execute();
    await migrate(db, sqliteStoreDialect);
    const store = createSqlStore({ db, dialect: sqliteStoreDialect });
    const listed = await store.projects.listTokens("org-1" as OrgId);
    expect(listed.items).toEqual([
      { id: "old-token", orgId: "org-1", scopes: ["event:read"] },
    ]);
    const revoked = await store.projects.revokeToken(
      "org-1" as OrgId,
      "old-token" as ApiTokenId,
      "2024-01-01T00:00:00.000Z" as Timestamp,
    );
    expect(revoked?.revokedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(
      (await store.projects.getTokenByHash("legacy-hash"))?.revokedAt,
    ).toBe("2024-01-01T00:00:00.000Z");
  });
  it("migrates legacy bundles and retains active debug-id lookups", async () => {
    const db = database(":memory:");
    await db.schema
      .createTable("schema_version")
      .addColumn("version", "integer", (c) => c.primaryKey())
      .execute();
    await createInitialSchema(db, sqliteStoreDialect);
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
    const store = createSqlStore({ db, dialect: sqliteStoreDialect });
    await store.migrate();
    expect(
      await store.releases.findBundleByDebugId(
        "1" as import("@moriyoshi/errtraq-core").ProjectId,
        "debug",
      ),
    ).toMatchObject({
      id: "old",
      state: "active",
      manifest: { blobKey: "old-blob", digest: "legacy", debugIdCount: 1 },
    });
  });
  it("uses indexes for issue and event access patterns", async () => {
    const db = database(":memory:");
    await migrate(db, sqliteStoreDialect);
    const queries: string[] = ["select * from issues where issue_id = 'i'"];
    for (const sort of ["first_seen", "last_seen", "count"])
      for (const status of [false, true])
        queries.push(
          `select * from issues where project_id = '1' ${status ? "and status = 'resolved'" : ""} order by ${sort} desc, issue_id asc limit 20`,
        );
    for (const direction of ["asc", "desc"])
      queries.push(
        `select * from events where project_id = '1' and issue_id = 'i' order by received_at ${direction}, event_id ${direction} limit 20`,
      );
    queries.push(
      "select * from events where project_id = '1' and received_at < '2024' order by received_at, event_id limit 20",
    );
    for (const column of ["user_id", "user_email", "user_name", "user_ip"])
      queries.push(
        `select * from events where project_id = '1' and ${column} = 'x' and received_at <= '2024' order by received_at, event_id limit 20`,
      );
    queries.push(
      "select * from events where pk in ('event-key') and received_at <= '2024'",
    );
    queries.push(
      "select bundles.data from bundle_debug_ids join bundles on bundles.pk = bundle_debug_ids.bundle_pk where bundle_debug_ids.project_id = '1' and bundle_debug_ids.debug_id = 'd'",
    );
    queries.push(
      "select * from erasures where state = 'received' order by pk",
      "select * from erasures where project_id = '1' order by pk",
      "select * from erasures where project_id = '1' and state = 'received' order by pk",
    );
    for (const query of queries) {
      const result = await sql.raw(`explain query plan ${query}`).execute(db);
      const plan = result.rows.map((row) => JSON.stringify(row)).join(" ");
      expect(plan, query).toMatch(/(?:USING INDEX|USING COVERING INDEX)/);
      expect(plan, query).not.toMatch(
        /TEMP B-TREE|SCAN (?:issues|events|erasures|bundles|bundle_debug_ids)(?:[\s"]|$)/,
      );
    }
  });
});

it("retries interleaved writes from two connections without snapshot upgrade failures", async () => {
  const path = join(directory, `shared-${++sequence}.db`);
  const left = database(path),
    right = database(path);
  const a = createSqlStore({ db: left, dialect: sqliteStoreDialect }),
    b = createSqlStore({ db: right, dialect: sqliteStoreDialect });
  await a.migrate();
  await b.migrate();
  const projectId = "1" as import("@moriyoshi/errtraq-core").ProjectId,
    issueId = "i" as import("@moriyoshi/errtraq-core").IssueId,
    eventId = "e" as import("@moriyoshi/errtraq-core").EventId,
    receivedAt =
      "2024-01-01T00:00:00.000Z" as import("@moriyoshi/errtraq-core").Timestamp;
  await a.recordEvent(
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
      user: { email: "x" },
    },
  );
  let release: (() => void) | undefined;
  let acquired: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const lock = left.transaction().execute(async () => {
    acquired?.();
    await hold;
  });
  await ready;
  const update = b.issues.update(projectId, issueId, { status: "resolved" });
  setTimeout(() => release?.(), 30);
  await Promise.all([lock, update]);
  expect((await b.issues.get(projectId, issueId))?.count).toBe(1);
});

it("chunks large event ID lists and respects the deletion limit", async () => {
  const db = database(":memory:");
  const store = createSqlStore({ db, dialect: sqliteStoreDialect });
  await store.migrate();
  const projectId = "1" as import("@moriyoshi/errtraq-core").ProjectId,
    issueId = "i" as import("@moriyoshi/errtraq-core").IssueId,
    receivedAt =
      "2024-01-01T00:00:00.000Z" as import("@moriyoshi/errtraq-core").Timestamp;
  const ids = Array.from(
    { length: 40000 },
    (_, i) => `e${i}` as import("@moriyoshi/errtraq-core").EventId,
  );
  for (const eventId of ids.slice(0, 3))
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
  await store.events.deleteBatch(projectId, ids);
  expect(
    await store.events.get(
      projectId,
      ids[2] as import("@moriyoshi/errtraq-core").EventId,
    ),
  ).toBeNull();
});

it("concurrent bootstraps on separate connections converge on one project and key", async () => {
  const path = join(directory, `bootstrap-${++sequence}.db`);
  const a = createSqlStore({ db: database(path), dialect: sqliteStoreDialect });
  const b = createSqlStore({ db: database(path), dialect: sqliteStoreDialect });
  await a.migrate();
  await b.migrate();
  const kv = new MemoryKV(new FakeClock());
  const options = {
    kv,
    ids: new WebCryptoIdGen(),
    orgSlug: "org",
    projectSlug: "project",
  };
  const [first, second] = await Promise.all([
    bootstrapProject({ ...options, store: a }),
    bootstrapProject({ ...options, store: b }),
  ]);
  expect(first.org.id).toBe(second.org.id);
  expect(first.project.id).toBe(second.project.id);
  expect(first.key.publicKey).toBe(second.key.publicKey);
  expect(await a.projects.listKeys(first.project.id)).toHaveLength(1);
});
