import { UnsupportedSchemaVersionError } from "@errtraq/core";
import type { Kysely } from "kysely";
import type { SqlStoreDialect } from "./dialect.js";

export type SqlDatabase = Kysely<
  Record<string, Record<string, string | number | null>>
>;

/** Apply numbered migrations transactionally; reject databases newer than this code. */
export async function migrate(
  db: SqlDatabase,
  dialect: SqlStoreDialect,
): Promise<void> {
  await db.schema
    .createTable("schema_version")
    .ifNotExists()
    .addColumn("version", "integer", (c) => c.primaryKey())
    .execute();
  const latest = await db
    .selectFrom("schema_version")
    .select("version")
    .orderBy("version", "desc")
    .executeTakeFirst();
  if (Number(latest?.version ?? 0) > 2)
    throw new UnsupportedSchemaVersionError(
      `Unsupported schema version ${String(latest?.version)}`,
    );
  const steps = [
    { version: 1, run: createInitialSchema },
    { version: 2, run: upgradeIndexes },
  ];
  for (const step of steps)
    await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom("schema_version")
        .select("version")
        .orderBy("version", "desc")
        .executeTakeFirst();
      const version = Number(current?.version ?? 0);
      if (version > 2)
        throw new UnsupportedSchemaVersionError(
          `Unsupported schema version ${version}`,
        );
      if (version >= step.version) return;
      await step.run(trx);
      await dialect.insertIfAbsent(
        trx,
        "schema_version",
        { version: step.version },
        "version",
      );
    });
}

/** The original version-one schema is kept intact for existing installations. */
export async function createInitialSchema(db: SqlDatabase): Promise<void> {
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
    await db.schema
      .createTable(table)
      .ifNotExists()
      .addColumn("pk", "text", (c) => c.primaryKey())
      .addColumn("project_id", "text")
      .addColumn("lookup", "text")
      .addColumn("scope", "text")
      .addColumn("version", "integer")
      .addColumn("state", "text")
      .addColumn("data", "text", (c) => c.notNull())
      .execute();
  }
  await db.schema
    .createTable("issues")
    .ifNotExists()
    .addColumn("pk", "text", (c) => c.primaryKey())
    .addColumn("project_id", "text", (c) => c.notNull())
    .addColumn("issue_id", "text", (c) => c.notNull())
    .addColumn("fingerprint", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull())
    .addColumn("first_seen", "text", (c) => c.notNull())
    .addColumn("last_seen", "text", (c) => c.notNull())
    .addColumn("count", "integer", (c) => c.notNull())
    .addColumn("data", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("events")
    .ifNotExists()
    .addColumn("pk", "text", (c) => c.primaryKey())
    .addColumn("project_id", "text", (c) => c.notNull())
    .addColumn("event_id", "text", (c) => c.notNull())
    .addColumn("issue_id", "text", (c) => c.notNull())
    .addColumn("received_at", "text", (c) => c.notNull())
    .addColumn("user_id", "text")
    .addColumn("user_email", "text")
    .addColumn("user_name", "text")
    .addColumn("user_ip", "text")
    .addColumn("level", "text")
    .addColumn("release", "text")
    .addColumn("environment", "text")
    .addColumn("tags", "text")
    .addColumn("data", "text", (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("bundle_debug_ids")
    .ifNotExists()
    .addColumn("project_id", "text", (c) => c.notNull())
    .addColumn("debug_id", "text", (c) => c.notNull())
    .addColumn("bundle_pk", "text", (c) => c.notNull())
    .addPrimaryKeyConstraint("bundle_debug_pk", [
      "project_id",
      "debug_id",
      "bundle_pk",
    ])
    .execute();
  const indexes: Array<[string, string, string[]]> = [
    ["org_slug", "orgs", ["lookup"]],
    ["project_slug", "projects", ["scope", "lookup"]],
    ["project_list", "projects", ["pk"]],
    ["keys_project", "keys", ["project_id"]],
    ["keys_public", "keys", ["lookup"]],
    ["token_hash", "tokens", ["lookup"]],
    ["release_version", "releases", ["project_id", "lookup"]],
    ["release_list", "releases", ["project_id", "pk"]],
    ["bundle_list", "bundles", ["project_id", "scope", "pk"]],
    ["bundle_debug_bundle", "bundle_debug_ids", ["bundle_pk"]],
    ["erasures_state", "erasures", ["state", "pk"]],
    ["erasures_project", "erasures", ["project_id", "state", "pk"]],
    ["issues_lookup", "issues", ["project_id", "issue_id"]],
    ["issues_fingerprint", "issues", ["project_id", "fingerprint"]],
    ...["first_seen", "last_seen", "count"].flatMap(
      (column): Array<[string, string, string[]]> => [
        [`issues_${column}`, "issues", ["project_id", column, "issue_id"]],
        [
          `issues_status_${column}`,
          "issues",
          ["project_id", "status", column, "issue_id"],
        ],
      ],
    ),
    [
      "events_issue",
      "events",
      ["project_id", "issue_id", "received_at", "event_id"],
    ],
    ["events_scan", "events", ["project_id", "received_at", "event_id"]],
    ["events_id", "events", ["project_id", "event_id"]],
    ...["user_id", "user_email", "user_name", "user_ip"].map(
      (column): [string, string, string[]] => [
        `events_${column}`,
        "events",
        ["project_id", column, "received_at", "event_id"],
      ],
    ),
  ];
  for (const [name, table, columns] of indexes)
    await db.schema
      .createIndex(name)
      .ifNotExists()
      .on(table)
      .columns(columns)
      .execute();
}

/** M1e migration: directional indexes and unique natural keys. */
export async function upgradeIndexes(db: SqlDatabase): Promise<void> {
  for (const name of [
    "issues_lookup",
    "issues_fingerprint",
    "project_list",
    "org_slug",
    "project_slug",
    "keys_public",
    "token_hash",
    "release_version",
    ...["first_seen", "last_seen", "count"].flatMap((col) => [
      `issues_${col}`,
      `issues_status_${col}`,
    ]),
  ])
    await db.schema.dropIndex(name).ifExists().execute();
  for (const col of ["first_seen", "last_seen", "count"]) {
    await db.schema
      .createIndex(`issues_${col}`)
      .ifNotExists()
      .on("issues")
      .columns(["project_id", `${col} desc`, "issue_id asc"])
      .execute();
    await db.schema
      .createIndex(`issues_status_${col}`)
      .ifNotExists()
      .on("issues")
      .columns(["project_id", "status", `${col} desc`, "issue_id asc"])
      .execute();
  }
  for (const [name, table, columns] of [
    ["org_slug_unique", "orgs", ["lookup"]],
    ["project_slug_unique", "projects", ["scope", "lookup"]],
    ["keys_public_unique", "keys", ["lookup"]],
    ["token_hash_unique", "tokens", ["lookup"]],
    ["release_version_unique", "releases", ["project_id", "lookup"]],
  ] as Array<[string, string, string[]]>)
    await db.schema
      .createIndex(name)
      .ifNotExists()
      .unique()
      .on(table)
      .columns(columns)
      .execute();
  await db.schema
    .createIndex("erasures_project_only")
    .ifNotExists()
    .on("erasures")
    .columns(["project_id", "pk"])
    .execute();
}
