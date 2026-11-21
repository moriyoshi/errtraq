import { UnsupportedSchemaVersionError } from "@errtraq/core";
import { type Kysely, sql } from "kysely";
import { createIndexIfAbsent, type SqlStoreDialect } from "./dialect.js";

export type SqlDatabase = Kysely<
  Record<string, Record<string, string | number | null>>
>;

/** Apply numbered migrations transactionally; reject databases newer than this code. */
export async function migrate(
  db: SqlDatabase,
  dialect: SqlStoreDialect,
): Promise<void> {
  if (dialect.kind === "postgres") {
    await db.transaction().execute(async (trx) => {
      await dialect.lock(trx, "errtraq:schema");
      await migrateLocked(trx, dialect, true);
      await sql`create statistics if not exists events_issue_dependencies (dependencies) on project_id, issue_id from events`.execute(
        trx,
      );
      await sql`create statistics if not exists bundles_scope_dependencies (dependencies) on project_id, scope from bundles`.execute(
        trx,
      );
    });
    return;
  }
  await migrateLocked(db, dialect, false);
}

async function migrateLocked(
  db: SqlDatabase,
  dialect: SqlStoreDialect,
  locked: boolean,
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
  if (Number(latest?.version ?? 0) > 3)
    throw new UnsupportedSchemaVersionError(
      `Unsupported schema version ${String(latest?.version)}`,
    );
  const steps = [
    { version: 1, run: (db: SqlDatabase) => createInitialSchema(db, dialect) },
    { version: 2, run: (db: SqlDatabase) => upgradeIndexes(db, dialect) },
    {
      version: 3,
      run: async (db: SqlDatabase) => {
        await dialect.createIndex(db, "issues_global_id", "issues", [
          "issue_id",
        ]);
      },
    },
  ];
  for (const step of steps) {
    const run = async (trx: SqlDatabase) => {
      const current = await trx
        .selectFrom("schema_version")
        .select("version")
        .orderBy("version", "desc")
        .executeTakeFirst();
      const version = Number(current?.version ?? 0);
      if (version > 3)
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
    };
    if (locked) await run(db);
    else await db.transaction().execute(run);
  }
}

/** The original version-one schema is kept intact for existing installations. */
export async function createInitialSchema(
  db: SqlDatabase,
  dialect?: SqlStoreDialect,
): Promise<void> {
  const keyType = dialect?.keyType ?? "text";
  const jsonType = dialect?.jsonType ?? "text";
  const integerType = dialect?.integerType ?? "integer";
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
      .addColumn("pk", keyType, (c) => c.primaryKey())
      .addColumn("project_id", keyType)
      .addColumn("lookup", keyType)
      .addColumn("scope", keyType)
      .addColumn("version", integerType)
      .addColumn("state", keyType)
      .addColumn("data", jsonType, (c) => c.notNull())
      .execute();
  }
  await db.schema
    .createTable("issues")
    .ifNotExists()
    .addColumn("pk", keyType, (c) => c.primaryKey())
    .addColumn("project_id", keyType, (c) => c.notNull())
    .addColumn("issue_id", keyType, (c) => c.notNull())
    .addColumn("fingerprint", keyType, (c) => c.notNull())
    .addColumn("status", keyType, (c) => c.notNull())
    .addColumn("first_seen", keyType, (c) => c.notNull())
    .addColumn("last_seen", keyType, (c) => c.notNull())
    .addColumn("count", integerType, (c) => c.notNull())
    .addColumn("data", jsonType, (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("events")
    .ifNotExists()
    .addColumn("pk", keyType, (c) => c.primaryKey())
    .addColumn("project_id", keyType, (c) => c.notNull())
    .addColumn("event_id", keyType, (c) => c.notNull())
    .addColumn("issue_id", keyType, (c) => c.notNull())
    .addColumn("received_at", keyType, (c) => c.notNull())
    .addColumn("user_id", keyType)
    .addColumn("user_email", keyType)
    .addColumn("user_name", keyType)
    .addColumn("user_ip", keyType)
    .addColumn("level", keyType)
    .addColumn("release", keyType)
    .addColumn("environment", keyType)
    .addColumn("tags", jsonType)
    .addColumn("data", jsonType, (c) => c.notNull())
    .execute();
  await db.schema
    .createTable("bundle_debug_ids")
    .ifNotExists()
    .addColumn("project_id", keyType, (c) => c.notNull())
    .addColumn("debug_id", keyType, (c) => c.notNull())
    .addColumn("bundle_pk", keyType, (c) => c.notNull())
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
    await (dialect?.createIndex ?? createIndexIfAbsent)(
      db,
      name,
      table,
      columns,
    );
}

/** M1e migration: directional indexes and unique natural keys. */
export async function upgradeIndexes(
  db: SqlDatabase,
  dialect?: SqlStoreDialect,
): Promise<void> {
  const createIndex = dialect?.createIndex ?? createIndexIfAbsent;
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
    await createIndex(db, `issues_${col}`, "issues", [
      "project_id",
      `${col} desc`,
      "issue_id asc",
    ]);
    await createIndex(db, `issues_status_${col}`, "issues", [
      "project_id",
      "status",
      `${col} desc`,
      "issue_id asc",
    ]);
  }
  for (const [name, table, columns] of [
    ["org_slug_unique", "orgs", ["lookup"]],
    ["project_slug_unique", "projects", ["scope", "lookup"]],
    ["keys_public_unique", "keys", ["lookup"]],
    ["token_hash_unique", "tokens", ["lookup"]],
    ["release_version_unique", "releases", ["project_id", "lookup"]],
  ] as Array<[string, string, string[]]>)
    await createIndex(db, name, table, columns, true);
  await createIndex(db, "erasures_project_only", "erasures", [
    "project_id",
    "pk",
  ]);
}
