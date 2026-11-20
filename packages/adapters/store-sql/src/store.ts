import {
  type ActiveStore,
  type ArchiveState,
  type ArtifactBundle,
  type Cursor,
  type ErasureRequest,
  type Issue,
  type IssueId,
  NotFoundError,
  type Page,
  type ProjectId,
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
const limitOf = (limit?: number) => Math.max(1, limit ?? 100);
const offsetOf = (cursor?: Cursor) => (cursor ? Number(cursor) : 0);
function page<T>(rows: T[], cursor?: Cursor, limit?: number): Page<T> {
  const size = limitOf(limit);
  return {
    items: rows.slice(0, size),
    nextCursor:
      rows.length > size ? (String(offsetOf(cursor) + size) as Cursor) : null,
  };
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
    await dialect.upsert(db, table, values);
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
    let q = db.selectFrom(table).select("data");
    if (query.projectId) q = q.where("project_id", "=", query.projectId);
    if (query.scope) q = q.where("scope", "=", query.scope);
    if (query.state) q = q.where("state", "=", query.state);
    const rows = await q
      .orderBy("pk")
      .limit(limitOf(query.limit) + 1)
      .offset(offsetOf(query.cursor))
      .execute();
    return page(
      rows.map((r) => decode<T>(r.data)),
      query.cursor,
      query.limit,
    );
  }
  const store: ActiveStore = {
    capabilities: { textSearch: false, lastSeenRangeOnOtherSort: false },
    migrate: async () => migrate(db, dialect),
    recordEvent: async (occurrence, event) => {
      if (
        occurrence.projectId !== event.projectId ||
        occurrence.issueId !== event.issueId ||
        occurrence.eventId !== event.eventId ||
        occurrence.receivedAt !== event.receivedAt
      )
        throw new Error("Occurrence and event mismatch");
      return db.transaction().execute(async (trx) => {
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
            occurrence.eventId > issue.lastEventId)
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
        const rows = await query
          .orderBy(column, "desc")
          .orderBy("issue_id", "asc")
          .limit(limitOf(q.limit) + 1)
          .offset(offsetOf(q.cursor))
          .execute();
        return page(
          rows.map((r) => decode<Issue>(r.data)),
          q.cursor,
          q.limit,
        );
      },
      update: async (projectId, id, patch) => {
        const issue = await byKey<Issue>("issues", pk(projectId, id));
        if (!issue) throw new NotFoundError("Issue not found");
        Object.assign(issue, patch);
        await db
          .updateTable("issues")
          .set({ status: issue.status, data: JSON.stringify(issue) })
          .where("pk", "=", pk(projectId, id))
          .execute();
        return issue;
      },
      repairAfterErasure: async (projectId, id, count) =>
        db.transaction().execute(async (trx) => {
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
          await trx
            .updateTable("issues")
            .set({ count: issue.count, data: JSON.stringify(issue) })
            .where("pk", "=", pk(projectId, id))
            .execute();
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
        const rows = await db
          .selectFrom("events")
          .select("data")
          .where("project_id", "=", projectId)
          .where("received_at", "<", cutoff)
          .orderBy("received_at")
          .orderBy("event_id")
          .limit(limitOf(options?.limit) + 1)
          .offset(offsetOf(options?.cursor))
          .execute();
        return page(
          rows.map((r) => decode<StoredEvent>(r.data)),
          options?.cursor,
          options?.limit,
        );
      },
      deleteBatch: async (projectId, ids) => {
        if (ids.length)
          await db
            .deleteFrom("events")
            .where("project_id", "=", projectId)
            .where("event_id", "in", ids)
            .execute();
      },
      deleteBySubject: async (projectId, selector, before, limit) =>
        db.transaction().execute(async (trx) => {
          if (limit < 1) throw new Error("Limit must be positive");
          let query = trx
            .selectFrom("events")
            .select(["pk", "data"])
            .where("project_id", "=", projectId)
            .where("received_at", "<=", before);
          if (selector.kind === "eventIds") {
            if (!selector.eventIds.length)
              return {
                deleted: 0,
                hasMore: false,
                issueCounts: [],
                payloadBlobKeys: [],
              };
            query = query.where("event_id", "in", selector.eventIds);
          } else {
            const column = {
              userId: "user_id",
              email: "user_email",
              username: "user_name",
              ipAddress: "user_ip",
            }[selector.kind];
            query = query.where(column, "=", selector.value);
          }
          const rows = await query
            .orderBy("received_at")
            .orderBy("event_id")
            .limit(limit + 1)
            .execute();
          const selected = rows.slice(0, limit);
          if (selected.length)
            await trx
              .deleteFrom("events")
              .where(
                "pk",
                "in",
                selected.map((r) => String(r.pk)),
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
        db.transaction().execute(async (trx) => {
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
        db.transaction().execute(async (trx) => {
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
      if (!(await dialect.insertIfAbsent(db, table, values)))
        throw new VersionConflictError("Already exists");
    } else {
      const r = await db
        .updateTable(table)
        .set(values)
        .where("pk", "=", key)
        .where("version", "=", expected)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1)
        throw new VersionConflictError("Version mismatch");
    }
  }
  return store;
}
