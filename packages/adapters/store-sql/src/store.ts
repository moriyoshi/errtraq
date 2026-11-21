import {
  type ActiveStore,
  type ArchiveState,
  type ArtifactBundle,
  ConflictError,
  type Cursor,
  decodeCursor,
  type ErasureRequest,
  encodeCursor,
  InvalidCursorError,
  type Issue,
  type IssueId,
  NotFoundError,
  type Page,
  type ProjectId,
  type ProjectKey,
  pageLimit,
  type StoredEvent,
  UnsupportedQueryError,
  VersionConflictError,
} from "@errtraq/core";
import type { SqlStoreDialect } from "./dialect.js";
import { migrate, type SqlDatabase } from "./schema.js";

export interface SqlStoreOptions {
  db: SqlDatabase;
  dialect: SqlStoreDialect;
}
const pk = (...parts: string[]) => JSON.stringify(parts);
const decode = <T>(data: unknown): T => JSON.parse(String(data)) as T;
const limitOf = pageLimit;
const encoder = new TextEncoder();
function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left),
    b = encoder.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta) return delta;
  }
  return a.length - b.length;
}
function cursorKeys(
  cursor: Cursor | undefined,
  scope: string,
  length: number,
): (string | number)[] | undefined {
  const keys = decodeCursor(cursor, scope);
  if (keys && keys.length !== length)
    throw new InvalidCursorError("Invalid cursor shape");
  return keys;
}

export function createSqlStore({ db, dialect }: SqlStoreOptions): ActiveStore {
  async function byKey<T>(table: string, key: string): Promise<T | null> {
    const row = await db
      .selectFrom(table)
      .select("data")
      .where("pk", "=", key)
      .executeTakeFirst();
    return row ? decode<T>(row.data) : null;
  }
  async function put(
    table: string,
    values: Record<string, string | number | null>,
  ) {
    try {
      await retryBusy(() => dialect.upsert(db, table, values));
    } catch (error) {
      const e = error as { errcode?: number; message?: string };
      if (
        e.errcode === 2067 ||
        (error as { code?: string }).code === "23505" ||
        /unique constraint failed/i.test(e.message ?? "")
      )
        throw new ConflictError("Natural key already exists");
      throw error;
    }
  }
  async function list<T>(
    table: string,
    query: {
      projectId?: string;
      scope?: string;
      state?: string;
      cursor?: Cursor;
      limit?: number;
    },
  ): Promise<Page<T>> {
    const scope = JSON.stringify([
      table,
      query.projectId ?? null,
      query.scope ?? null,
      query.state ?? null,
    ]);
    const after = cursorKeys(query.cursor, scope, 1);
    if (after && typeof after[0] !== "string")
      throw new InvalidCursorError("Invalid cursor key");
    let q = db.selectFrom(table).select(["pk", "data"]);
    if (query.projectId) q = q.where("project_id", "=", query.projectId);
    if (query.scope) q = q.where("scope", "=", query.scope);
    if (query.state) q = q.where("state", "=", query.state);
    if (after) q = q.where("pk", ">", after[0] as string);
    const size = limitOf(query.limit);
    const rows = await q
      .orderBy("pk")
      .limit(size + 1)
      .execute();
    const selected = rows.slice(0, size);
    const last = selected.at(-1);
    return {
      items: selected.map((r) => decode<T>(r.data)),
      nextCursor:
        rows.length > size && last
          ? encodeCursor(scope, [String(last.pk)])
          : null,
    };
  }
  async function retryBusy<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const e = error as {
          code?: string;
          errcode?: number;
          message?: string;
        };
        const busy =
          (typeof e.errcode === "number" && (e.errcode & 255) === 5) ||
          e.code === "SQLITE_BUSY" ||
          e.code === "40001" ||
          e.code === "40P01" ||
          /database is (?:locked|busy)/i.test(e.message ?? "");
        if (!busy || attempt >= 7) throw error;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(50, 2 ** attempt * 2)),
        );
      }
    }
  }
  const transaction = <T>(operation: (trx: SqlDatabase) => Promise<T>) =>
    retryBusy(() => db.transaction().execute(operation));
  const store: ActiveStore = {
    capabilities: { textSearch: false, lastSeenRangeOnOtherSort: false },
    migrate: async () => retryBusy(() => migrate(db, dialect)),
    recordEvent: async (occurrence, event) => {
      if (
        occurrence.projectId !== event.projectId ||
        occurrence.issueId !== event.issueId ||
        occurrence.eventId !== event.eventId ||
        occurrence.receivedAt !== event.receivedAt
      )
        throw new Error("Occurrence and event mismatch");
      return transaction(async (trx) => {
        await dialect.lock(
          trx,
          `issue:${pk(occurrence.projectId, occurrence.issueId)}`,
        );
        const inserted = await dialect.insertIfAbsent(trx, "events", {
          pk: pk(event.projectId, event.eventId),
          project_id: event.projectId,
          event_id: event.eventId,
          issue_id: event.issueId,
          received_at: event.receivedAt,
          user_id: event.user?.id ?? null,
          user_email: event.user?.email ?? null,
          user_name: event.user?.username ?? null,
          user_ip: event.user?.ipAddress ?? null,
          level: event.level,
          release: event.release ?? null,
          environment: event.environment ?? null,
          tags: JSON.stringify(event.tags),
          data: JSON.stringify(event),
        });
        if (!inserted) {
          const old = await trx
            .selectFrom("events")
            .select("data")
            .where("pk", "=", pk(event.projectId, event.eventId))
            .executeTakeFirstOrThrow();
          const saved = decode<StoredEvent>(old.data);
          const issue = await trx
            .selectFrom("issues")
            .select("data")
            .where("pk", "=", pk(saved.projectId, saved.issueId))
            .executeTakeFirstOrThrow();
          return {
            inserted: false,
            issue: decode<Issue>(issue.data),
            isNew: false,
            isRegression: false,
          };
        }
        const key = pk(occurrence.projectId, occurrence.issueId);
        const row = await trx
          .selectFrom("issues")
          .select("data")
          .where("pk", "=", key)
          .executeTakeFirst();
        const isNew = !row;
        const issue: Issue = row
          ? decode<Issue>(row.data)
          : {
              id: occurrence.issueId,
              projectId: occurrence.projectId,
              fingerprint: occurrence.fingerprint,
              status: "unresolved",
              title: occurrence.title,
              culprit: occurrence.culprit,
              level: occurrence.level,
              type: occurrence.type,
              metadata: occurrence.metadata,
              firstSeen: occurrence.receivedAt,
              lastSeen: occurrence.receivedAt,
              count: 0,
              lastEventId: occurrence.eventId,
              lastEventReceivedAt: occurrence.receivedAt,
            };
        if (issue.fingerprint !== occurrence.fingerprint)
          throw new Error("Issue fingerprint mismatch");
        const isRegression =
          issue.status === "resolved" &&
          (!issue.resolvedAt || occurrence.receivedAt > issue.resolvedAt);
        issue.count++;
        if (occurrence.receivedAt < issue.firstSeen)
          issue.firstSeen = occurrence.receivedAt;
        if (
          occurrence.receivedAt > issue.lastSeen ||
          (occurrence.receivedAt === issue.lastSeen &&
            compareUtf8(occurrence.eventId, issue.lastEventId) > 0)
        ) {
          issue.lastSeen = occurrence.receivedAt;
          issue.lastEventReceivedAt = occurrence.receivedAt;
          issue.lastEventId = occurrence.eventId;
        }
        if (isRegression) {
          issue.status = "unresolved";
          delete issue.resolvedAt;
        }
        const values = {
          pk: key,
          project_id: issue.projectId,
          issue_id: issue.id,
          fingerprint: issue.fingerprint,
          status: issue.status,
          first_seen: issue.firstSeen,
          last_seen: issue.lastSeen,
          count: issue.count,
          data: JSON.stringify(issue),
        };
        await dialect.upsert(trx, "issues", values);
        return { inserted: true, issue, isNew, isRegression };
      });
    },
    projects: {
      getOrg: (id) => byKey("orgs", id),
      getOrgBySlug: async (slug) => {
        const r = await db
          .selectFrom("orgs")
          .select("data")
          .where("lookup", "=", slug)
          .executeTakeFirst();
        return r ? decode(r.data) : null;
      },
      putOrg: async (org) =>
        put("orgs", {
          pk: org.id,
          lookup: org.slug,
          data: JSON.stringify(org),
        }),
      get: (id) => byKey("projects", id),
      getProjectBySlug: async (orgId, slug) => {
        const r = await db
          .selectFrom("projects")
          .select("data")
          .where("scope", "=", orgId)
          .where("lookup", "=", slug)
          .executeTakeFirst();
        return r ? decode(r.data) : null;
      },
      put: async (p) =>
        put("projects", {
          pk: p.id,
          scope: p.orgId,
          lookup: p.slug,
          data: JSON.stringify(p),
        }),
      list: (cursor, limit) => list("projects", { cursor, limit }),
      getKey: async (key) => {
        const r = await db
          .selectFrom("keys")
          .select("data")
          .where("lookup", "=", key)
          .executeTakeFirst();
        return r ? decode(r.data) : null;
      },
      putKey: async (key) =>
        put("keys", {
          pk: key.id,
          project_id: key.projectId,
          lookup: key.publicKey,
          data: JSON.stringify(key),
        }),
      getOrCreateActiveKey: async (key) =>
        transaction(async (trx) => {
          await dialect.lock(trx, `keys:${key.projectId}`);
          const rows = await trx
            .selectFrom("keys")
            .select("data")
            .where("project_id", "=", key.projectId)
            .execute();
          const existing = rows
            .map((row) => decode<ProjectKey>(row.data))
            .find((row) => !row.revokedAt);
          if (existing) return existing;
          await trx
            .insertInto("keys")
            .values({
              pk: key.id,
              project_id: key.projectId,
              lookup: key.publicKey,
              data: JSON.stringify(key),
            })
            .execute();
          return key;
        }),
      listKeys: async (projectId) => {
        const rows = await db
          .selectFrom("keys")
          .select("data")
          .where("project_id", "=", projectId)
          .execute();
        return rows.map((r) => decode(r.data));
      },
      getTokenByHash: async (hash) => {
        const r = await db
          .selectFrom("tokens")
          .select("data")
          .where("lookup", "=", hash)
          .executeTakeFirst();
        return r ? decode(r.data) : null;
      },
      putToken: async (token) =>
        put("tokens", {
          pk: token.id,
          lookup: token.tokenHash,
          data: JSON.stringify(token),
        }),
    },
    issues: {
      getById: async (id) => {
        const row = await db
          .selectFrom("issues")
          .select("data")
          .where("issue_id", "=", id)
          .execute();
        return row.map((item) => decode<Issue>(item.data));
      },
      get: (projectId, id) => byKey("issues", pk(projectId, id)),
      list: async (q) => {
        if (q.text || ((q.from || q.to) && q.sort !== "lastSeen"))
          throw new UnsupportedQueryError("Unsupported issue filter");
        const column = {
          firstSeen: "first_seen",
          lastSeen: "last_seen",
          count: "count",
        }[q.sort] as string;
        let query = db
          .selectFrom("issues")
          .select("data")
          .where("project_id", "=", q.projectId);
        if (q.status) query = query.where("status", "=", q.status);
        if (q.from) query = query.where("last_seen", ">=", q.from);
        if (q.to) query = query.where("last_seen", "<", q.to);
        const scope = JSON.stringify([
          "issues",
          q.projectId,
          q.sort,
          q.status ?? null,
          q.from ?? null,
          q.to ?? null,
        ]);
        const after = cursorKeys(q.cursor, scope, 2);
        if (after) {
          const [sortKey, id] = after;
          if (
            (q.sort === "count"
              ? typeof sortKey !== "number"
              : typeof sortKey !== "string") ||
            typeof id !== "string"
          )
            throw new InvalidCursorError("Invalid issue cursor");
          query = query.where((eb) =>
            eb.or([
              eb(column, "<", sortKey ?? ""),
              eb.and([eb(column, "=", sortKey ?? ""), eb("issue_id", ">", id)]),
            ]),
          );
        }
        const size = limitOf(q.limit);
        const rows = await query
          .select([column, "issue_id"])
          .orderBy(column, "desc")
          .orderBy("issue_id", "asc")
          .limit(size + 1)
          .execute();
        const selected = rows.slice(0, size);
        const last = selected.at(-1);
        return {
          items: selected.map((r) => decode<Issue>(r.data)),
          nextCursor:
            rows.length > size && last
              ? encodeCursor(scope, [
                  last[column] as string | number,
                  String(last.issue_id),
                ])
              : null,
        };
      },
      update: async (projectId, id, patch) =>
        transaction(async (trx) => {
          await dialect.lock(trx, `issue:${pk(projectId, id)}`);
          const row = await trx
            .selectFrom("issues")
            .select("data")
            .where("pk", "=", pk(projectId, id))
            .executeTakeFirst();
          if (!row) throw new NotFoundError("Issue not found");
          const issue = decode<Issue>(row.data);
          Object.assign(issue, patch);
          const updated = await trx
            .updateTable("issues")
            .set({ status: issue.status, data: JSON.stringify(issue) })
            .where("pk", "=", pk(projectId, id))
            .where("data", "=", String(row.data))
            .executeTakeFirst();
          if (!dialect.didUpdate(updated.numUpdatedRows))
            throw new VersionConflictError("Issue changed concurrently");
          return issue;
        }),
      repairAfterErasure: async (projectId, id, count) =>
        transaction(async (trx) => {
          await dialect.lock(trx, `issue:${pk(projectId, id)}`);
          const row = await trx
            .selectFrom("issues")
            .select("data")
            .where("pk", "=", pk(projectId, id))
            .executeTakeFirst();
          if (!row) throw new NotFoundError("Issue not found");
          const issue = decode<Issue>(row.data);
          issue.count = Math.max(0, issue.count - count);
          const latest = await trx
            .selectFrom("events")
            .select("data")
            .where("project_id", "=", projectId)
            .where("issue_id", "=", id)
            .orderBy("received_at", "desc")
            .orderBy("event_id", "desc")
            .executeTakeFirst();
          if (latest) {
            const event = decode<StoredEvent>(latest.data);
            issue.lastEventId = event.eventId;
            issue.lastEventReceivedAt = event.receivedAt;
          }
          const updated = await trx
            .updateTable("issues")
            .set({ count: issue.count, data: JSON.stringify(issue) })
            .where("pk", "=", pk(projectId, id))
            .where("data", "=", String(row.data))
            .executeTakeFirst();
          if (!dialect.didUpdate(updated.numUpdatedRows))
            throw new VersionConflictError("Issue changed concurrently");
          return issue;
        }),
    },
    events: {
      capabilities: { deleteStrategy: "explicit" },
      get: (projectId, id) => byKey("events", pk(projectId, id)),
      listByIssue: async (q) => {
        let query = db
          .selectFrom("events")
          .select("data")
          .where("project_id", "=", q.projectId);
        if (q.issueId) query = query.where("issue_id", "=", q.issueId);
        if (q.from) query = query.where("received_at", ">=", q.from);
        if (q.to) query = query.where("received_at", "<", q.to);
        const order = q.order ?? "desc";
        if (q.after) {
          const after = q.after;
          query = query.where((eb) =>
            eb.or([
              eb("received_at", order === "asc" ? ">" : "<", after.receivedAt),
              eb.and([
                eb("received_at", "=", after.receivedAt),
                eb("event_id", order === "asc" ? ">" : "<", after.eventId),
              ]),
            ]),
          );
        }
        const rows = await query
          .orderBy("received_at", order)
          .orderBy("event_id", order)
          .limit(limitOf(q.limit) + 1)
          .execute();
        return {
          items: rows
            .slice(0, limitOf(q.limit))
            .map((r) => decode<StoredEvent>(r.data)),
          hasMore: rows.length > limitOf(q.limit),
        };
      },
      scanOlderThan: async (projectId, cutoff, options) => {
        const scope = JSON.stringify(["scan", projectId, cutoff]);
        const after = cursorKeys(options?.cursor, scope, 2);
        let q = db
          .selectFrom("events")
          .select(["data", "received_at", "event_id"])
          .where("project_id", "=", projectId)
          .where("received_at", "<", cutoff);
        if (after) {
          const [time, id] = after;
          if (typeof time !== "string" || typeof id !== "string")
            throw new InvalidCursorError("Invalid scan cursor");
          q = q.where((eb) =>
            eb.or([
              eb("received_at", ">", time),
              eb.and([eb("received_at", "=", time), eb("event_id", ">", id)]),
            ]),
          );
        }
        const size = limitOf(options?.limit);
        const rows = await q
          .orderBy("received_at")
          .orderBy("event_id")
          .limit(size + 1)
          .execute();
        const selected = rows.slice(0, size);
        const last = selected.at(-1);
        return {
          items: selected.map((r) => decode<StoredEvent>(r.data)),
          nextCursor:
            rows.length > size && last
              ? encodeCursor(scope, [
                  String(last.received_at),
                  String(last.event_id),
                ])
              : null,
        };
      },
      deleteBatch: async (projectId, ids) => {
        for (let i = 0; i < ids.length; i += dialect.maxParameters - 1)
          await retryBusy(() =>
            db
              .deleteFrom("events")
              .where("project_id", "=", projectId)
              .where(
                "event_id",
                "in",
                ids.slice(i, i + dialect.maxParameters - 1),
              )
              .execute(),
          );
      },
      deleteBySubject: async (projectId, selector, before, limit) =>
        transaction(async (trx) => {
          limitOf(limit);
          const query = trx
            .selectFrom("events")
            .select(["pk", "data"])
            .where("project_id", "=", projectId)
            .where("received_at", "<=", before);
          let rows: Array<{
            pk: string | number | null;
            data: string | number | null;
          }>;
          if (selector.kind === "eventIds") {
            const found: typeof rows = [];
            const ids = [...new Set(selector.eventIds)];
            for (let i = 0; i < ids.length; i += dialect.maxParameters - 1) {
              const chunk = ids
                .slice(i, i + dialect.maxParameters - 1)
                .map((id) => pk(projectId, id));
              if (chunk.length)
                found.push(
                  ...(await trx
                    .selectFrom("events")
                    .select(["pk", "data"])
                    .where("pk", "in", chunk)
                    .where("received_at", "<=", before)
                    .execute()),
                );
            }
            rows = found
              .sort((a, b) => {
                const x = decode<StoredEvent>(a.data),
                  y = decode<StoredEvent>(b.data);
                return (
                  compareUtf8(x.receivedAt, y.receivedAt) ||
                  compareUtf8(x.eventId, y.eventId)
                );
              })
              .slice(0, limit + 1);
          } else {
            const column = {
              userId: "user_id",
              email: "user_email",
              username: "user_name",
              ipAddress: "user_ip",
            }[selector.kind];
            rows = await query
              .where(column, "=", selector.value)
              .orderBy("received_at")
              .orderBy("event_id")
              .limit(limit + 1)
              .execute();
          }
          const selected = rows.slice(0, limit);
          for (let i = 0; i < selected.length; i += dialect.maxParameters)
            await trx
              .deleteFrom("events")
              .where(
                "pk",
                "in",
                selected
                  .slice(i, i + dialect.maxParameters)
                  .map((r) => String(r.pk)),
              )
              .execute();
          const counts = new Map<IssueId, number>();
          const keys: string[] = [];
          for (const row of selected) {
            const e = decode<StoredEvent>(row.data);
            counts.set(e.issueId, (counts.get(e.issueId) ?? 0) + 1);
            if (e.payloadBlobKey) keys.push(e.payloadBlobKey);
          }
          return {
            deleted: selected.length,
            hasMore: rows.length > limit,
            issueCounts: [...counts].map(([issueId, count]) => ({
              issueId,
              count,
            })),
            payloadBlobKeys: keys,
          };
        }),
    },
    releases: {
      get: (projectId, id) => byKey("releases", pk(projectId, id)),
      put: async (release) =>
        put("releases", {
          pk: pk(release.projectId, release.id),
          project_id: release.projectId,
          lookup: release.version,
          data: JSON.stringify(release),
        }),
      getReleaseByVersion: async (projectId, version) => {
        const r = await db
          .selectFrom("releases")
          .select("data")
          .where("project_id", "=", projectId)
          .where("lookup", "=", version)
          .executeTakeFirst();
        return r ? decode(r.data) : null;
      },
      list: (projectId, cursor, limit) =>
        list("releases", { projectId, cursor, limit }),
      putBundle: async (bundle) =>
        transaction(async (trx) => {
          const key = pk(bundle.projectId, bundle.id);
          const values = {
            pk: key,
            project_id: bundle.projectId,
            scope: bundle.releaseId,
            data: JSON.stringify(bundle),
          };
          await dialect.upsert(trx, "bundles", values);
          await trx
            .deleteFrom("bundle_debug_ids")
            .where("bundle_pk", "=", key)
            .execute();
          for (const debug of bundle.debugIds)
            await trx
              .insertInto("bundle_debug_ids")
              .values({
                project_id: bundle.projectId,
                debug_id: debug,
                bundle_pk: key,
              })
              .execute();
        }),
      listBundles: (projectId, releaseId, cursor, limit) =>
        list("bundles", { projectId, scope: releaseId, cursor, limit }),
      deleteBundle: async (projectId, id) =>
        transaction(async (trx) => {
          const key = pk(projectId, id);
          await trx
            .deleteFrom("bundle_debug_ids")
            .where("bundle_pk", "=", key)
            .execute();
          await trx.deleteFrom("bundles").where("pk", "=", key).execute();
        }),
      findBundleByDebugId: async (projectId, debugId) => {
        const r = await db
          .selectFrom("bundle_debug_ids")
          .innerJoin("bundles", "bundles.pk", "bundle_debug_ids.bundle_pk")
          .select("bundles.data")
          .where("bundle_debug_ids.project_id", "=", projectId)
          .where("bundle_debug_ids.debug_id", "=", debugId)
          .executeTakeFirst();
        return r ? decode<ArtifactBundle>(r.data) : null;
      },
    },
    meta: {
      getArchiveState: (projectId) => byKey("archive_states", projectId),
      compareAndSetArchiveState: async (projectId, expected, next) =>
        cas("archive_states", projectId, projectId, expected, next),
      getErasureRequest: (projectId, id) =>
        byKey("erasures", pk(projectId, id)),
      listErasureRequests: ({ projectId, state, cursor, limit }) =>
        list<ErasureRequest>("erasures", { projectId, state, cursor, limit }),
      compareAndSetErasureRequest: async (projectId, id, expected, next) =>
        cas("erasures", pk(projectId, id), projectId, expected, next),
    },
  };
  async function cas(
    table: string,
    key: string,
    projectId: ProjectId,
    expected: number | null,
    next: ArchiveState | ErasureRequest,
  ) {
    if (
      next.projectId !== projectId ||
      next.version !== (expected === null ? 0 : expected + 1) ||
      ("id" in next && pk(projectId, next.id) !== key)
    )
      throw new VersionConflictError("Invalid version");
    const values = {
      pk: key,
      project_id: projectId,
      version: next.version,
      state: "state" in next ? next.state : null,
      data: JSON.stringify(next),
    };
    if (expected === null) {
      if (!(await retryBusy(() => dialect.insertIfAbsent(db, table, values))))
        throw new VersionConflictError("Already exists");
    } else {
      const r = await retryBusy(() =>
        db
          .updateTable(table)
          .set(values)
          .where("pk", "=", key)
          .where("version", "=", expected)
          .executeTakeFirst(),
      );
      if (!dialect.didUpdate(r.numUpdatedRows))
        throw new VersionConflictError("Version mismatch");
    }
  }
  return store;
}
