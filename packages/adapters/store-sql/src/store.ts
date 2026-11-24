import {
  type ActiveStore,
  type ArchiveState,
  type ArtifactBundle,
  bundleDebugIdsDigest,
  ConflictError,
  type Cursor,
  decodeCursor,
  type ErasureRequest,
  encodeCursor,
  eventCursorScope,
  InvalidCursorError,
  type Issue,
  NotFoundError,
  type Occurrence,
  type Page,
  type ProjectId,
  type ProjectKey,
  pageLimit,
  type RecordInput,
  type RecordResult,
  type StoredEvent,
  UnsupportedQueryError,
  VersionConflictError,
  withIdentifierLimits,
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
  async function recordOne(
    trx: SqlDatabase,
    occurrence: Occurrence,
    event: StoredEvent,
  ): Promise<RecordResult> {
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
  }
  function validateGroup(group: readonly RecordInput[]): void {
    if (!Array.isArray(group) || group.length < 1 || group.length > 10)
      throw new RangeError("Record group must contain 1 to 10 events");
    const first = group[0]?.occurrence;
    if (!first) throw new TypeError("Missing record group");
    for (const { occurrence, event } of group) {
      if (
        occurrence.projectId !== first.projectId ||
        occurrence.issueId !== first.issueId ||
        occurrence.fingerprint !== first.fingerprint ||
        occurrence.projectId !== event.projectId ||
        occurrence.issueId !== event.issueId ||
        occurrence.eventId !== event.eventId ||
        occurrence.receivedAt !== event.receivedAt
      )
        throw new TypeError("Record group identity mismatch");
      JSON.stringify(occurrence);
      JSON.stringify(event);
    }
  }
  const store: ActiveStore = {
    capabilities: {
      textSearch: false,
      lastSeenRangeOnOtherSort: false,
      recordEvents: true,
    },
    migrate: async () => retryBusy(() => migrate(db, dialect)),
    recordEvent: async (occurrence, event) => {
      validateGroup([{ occurrence, event }]);
      return transaction(async (trx) => {
        await dialect.lock(
          trx,
          `issue:${pk(occurrence.projectId, occurrence.issueId)}`,
        );
        return recordOne(trx, occurrence, event);
      });
    },
    recordEvents: async (group) => {
      validateGroup(group);
      const first = group[0];
      if (!first) throw new TypeError("Missing record group");
      return transaction(async (trx) => {
        await dialect.lock(
          trx,
          `issue:${pk(first.occurrence.projectId, first.occurrence.issueId)}`,
        );
        const results: RecordResult[] = [];
        for (const { occurrence, event } of group)
          results.push(await recordOne(trx, occurrence, event));
        const row = await trx
          .selectFrom("issues")
          .select("data")
          .where(
            "pk",
            "=",
            pk(first.occurrence.projectId, first.occurrence.issueId),
          )
          .executeTakeFirst();
        const final = row ? decode<Issue>(row.data) : undefined;
        return results.map((result) =>
          final &&
          result.issue.projectId === final.projectId &&
          result.issue.id === final.id
            ? { ...result, issue: final }
            : result,
        );
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
      createToken: async (token) => {
        const result = await retryBusy(() =>
          db
            .insertInto("tokens")
            .values({
              pk: token.id,
              lookup: token.tokenHash,
              data: JSON.stringify(token),
            })
            .onConflict((conflict) => conflict.doNothing())
            .executeTakeFirst(),
        );
        if (dialect.didUpdate(result.numInsertedOrUpdatedRows)) return true;
        if (
          await db
            .selectFrom("tokens")
            .select("pk")
            .where("lookup", "=", token.tokenHash)
            .executeTakeFirst()
        )
          return false;
        throw new ConflictError("Token ID already exists");
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
      repairAfterErasure: async () => {
        throw new UnsupportedQueryError(
          "Subject erasure is unavailable until M4",
        );
      },
    },
    events: {
      capabilities: { deleteStrategy: "explicit", deleteBySubject: false },
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
        const scope = eventCursorScope(q);
        const keys = cursorKeys(q.cursor, scope, 2);
        if (
          keys &&
          (typeof keys[0] !== "string" || typeof keys[1] !== "string")
        )
          throw new InvalidCursorError("Invalid event cursor");
        const position = keys
          ? { receivedAt: String(keys[0]), eventId: String(keys[1]) }
          : q.after;
        if (position) {
          const after = position;
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
        const items = rows
          .slice(0, limitOf(q.limit))
          .map((r) => decode<StoredEvent>(r.data));
        const last = items.at(-1);
        const nextCursor =
          rows.length > limitOf(q.limit) && last
            ? encodeCursor(scope, [last.receivedAt, last.eventId])
            : null;
        return { items, hasMore: nextCursor !== null, nextCursor };
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
      deleteBySubject: async () => {
        throw new UnsupportedQueryError(
          "Subject erasure is unavailable until M4",
        );
      },
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
      beginBundle: async (bundle, manifest) =>
        transaction(async (trx) => {
          await dialect.lock(trx, `bundles:${bundle.projectId}`);
          if (
            bundle.state !== "pending" ||
            !bundle.pendingExpiresAt ||
            JSON.stringify(bundle.manifest) !== JSON.stringify(manifest)
          )
            throw new ConflictError("Invalid pending bundle");
          const key = pk(bundle.projectId, bundle.id);
          const existing = await trx
            .selectFrom("bundles")
            .select("data")
            .where("pk", "=", key)
            .executeTakeFirst();
          if (existing) {
            if (
              JSON.stringify(decode<ArtifactBundle>(existing.data)) !==
              JSON.stringify(bundle)
            )
              throw new ConflictError("Bundle already exists");
            return;
          }
          await trx
            .insertInto("bundles")
            .values({
              pk: key,
              project_id: bundle.projectId,
              scope: bundle.releaseId,
              state: "pending",
              data: JSON.stringify(bundle),
            })
            .execute();
        }),
      putBundleDebugIds: async (projectId, bundleId, ids, manifestIds) => {
        const digest = await bundleDebugIdsDigest(manifestIds);
        await transaction(async (trx) => {
          await dialect.lock(trx, `bundles:${projectId}`);
          const key = pk(projectId, bundleId);
          const row = await trx
            .selectFrom("bundles")
            .select("data")
            .where("pk", "=", key)
            .executeTakeFirst();
          const bundle = row ? decode<ArtifactBundle>(row.data) : null;
          if (bundle?.state !== "pending" || bundle.cleanupStarted)
            throw new ConflictError("Bundle is not pending");
          const expected = new Set(manifestIds);
          if (
            ids.length > 100 ||
            expected.size !== manifestIds.length ||
            manifestIds.length !== bundle.manifest.debugIdCount ||
            digest !== bundle.manifest.digest ||
            ids.some((id) => !expected.has(id))
          )
            throw new ConflictError("Chunk does not match bundle manifest");
          const chunk = [...new Set(ids)];
          if (chunk.length) {
            const owners = await trx
              .selectFrom("bundle_debug_ids")
              .select(["debug_id", "bundle_pk"])
              .where("project_id", "=", projectId)
              .where("debug_id", "in", chunk)
              .execute();
            if (owners.some((owner) => owner.bundle_pk !== key))
              throw new ConflictError("Debug ID already owned");
            const existing = new Set(
              owners.map((owner) => String(owner.debug_id)),
            );
            const missing = chunk.filter((id) => !existing.has(id));
            if (missing.length)
              await trx
                .insertInto("bundle_debug_ids")
                .values(
                  missing.map((id) => ({
                    project_id: projectId,
                    debug_id: id,
                    bundle_pk: key,
                  })),
                )
                .execute();
          }
        });
      },
      verifyAndActivateBundle: async (projectId, bundleId, ids) => {
        const digest = await bundleDebugIdsDigest(ids);
        await transaction(async (trx) => {
          await dialect.lock(trx, `bundles:${projectId}`);
          const key = pk(projectId, bundleId);
          const row = await trx
            .selectFrom("bundles")
            .select("data")
            .where("pk", "=", key)
            .executeTakeFirst();
          if (!row) throw new ConflictError("Bundle not found");
          const bundle = decode<ArtifactBundle>(row.data);
          if (bundle.cleanupStarted)
            throw new ConflictError("Bundle is being cleaned");
          const markers = await trx
            .selectFrom("bundle_debug_ids")
            .select("debug_id")
            .where("bundle_pk", "=", key)
            .execute();
          const actual = new Set(markers.map((x) => String(x.debug_id)));
          if (
            new Set(ids).size !== ids.length ||
            ids.length !== bundle.manifest.debugIdCount ||
            digest !== bundle.manifest.digest ||
            actual.size !== ids.length ||
            ids.some((id) => !actual.has(id))
          )
            throw new ConflictError("Bundle manifest does not match markers");
          bundle.state = "active";
          delete bundle.pendingExpiresAt;
          await trx
            .updateTable("bundles")
            .set({ state: "active", data: JSON.stringify(bundle) })
            .where("pk", "=", key)
            .execute();
        });
      },
      listPendingBundles: async (projectId, before, cursor, limit) => {
        const scope = JSON.stringify(["pending-bundles", projectId, before]);
        const keys = cursorKeys(cursor, scope, 1);
        if (keys && typeof keys[0] !== "string")
          throw new InvalidCursorError("Invalid pending bundle cursor");
        let q = db
          .selectFrom("bundles")
          .select(["pk", "data"])
          .where("project_id", "=", projectId)
          .where("state", "=", "pending");
        if (keys) q = q.where("pk", ">", String(keys[0]));
        // Existing generic schema does not index expiry; examine keys until a full page or exhaustion.
        const size = limitOf(limit),
          found: ArtifactBundle[] = [];
        let last: string | undefined;
        for (;;) {
          const rows = await q.orderBy("pk").limit(100).execute();
          if (!rows.length) return { items: found, nextCursor: null };
          for (const row of rows) {
            last = String(row.pk);
            const bundle = decode<ArtifactBundle>(row.data);
            if (bundle.pendingExpiresAt && bundle.pendingExpiresAt <= before)
              found.push(bundle);
            if (found.length === size)
              return { items: found, nextCursor: encodeCursor(scope, [last]) };
          }
          if (rows.length < 100) return { items: found, nextCursor: null };
          q = q.where("pk", ">", last as string);
        }
      },
      claimPendingBundleCleanup: async (projectId, bundleId, before) =>
        transaction(async (trx) => {
          await dialect.lock(trx, `bundles:${projectId}`);
          const key = pk(projectId, bundleId);
          const row = await trx
            .selectFrom("bundles")
            .select("data")
            .where("pk", "=", key)
            .executeTakeFirst();
          const bundle = row ? decode<ArtifactBundle>(row.data) : null;
          if (
            bundle?.state !== "pending" ||
            !bundle.pendingExpiresAt ||
            bundle.pendingExpiresAt > before
          )
            return null;
          bundle.cleanupStarted = true;
          bundle.cleanupId ??= crypto.randomUUID();
          await trx
            .updateTable("bundles")
            .set({ data: JSON.stringify(bundle) })
            .where("pk", "=", key)
            .execute();
          return bundle;
        }),
      clearPendingBundleDebugIds: async (
        projectId,
        bundleId,
        ids,
        cleanupId,
      ) => {
        const digest = await bundleDebugIdsDigest(ids);
        await transaction(async (trx) => {
          await dialect.lock(trx, `bundles:${projectId}`);
          const key = pk(projectId, bundleId);
          const row = await trx
            .selectFrom("bundles")
            .select("data")
            .where("pk", "=", key)
            .executeTakeFirst();
          const bundle = row ? decode<ArtifactBundle>(row.data) : null;
          if (
            bundle?.state !== "pending" ||
            !bundle.cleanupStarted ||
            bundle.cleanupId !== cleanupId
          )
            throw new ConflictError("Bundle cleanup not claimed");
          if (bundle.cleanupMarkersCleared) return;
          if (
            ids.length !== bundle.manifest.debugIdCount ||
            new Set(ids).size !== ids.length ||
            digest !== bundle.manifest.digest
          )
            throw new ConflictError("Invalid bundle manifest");
          const markers = await trx
            .selectFrom("bundle_debug_ids")
            .select("debug_id")
            .where("bundle_pk", "=", key)
            .execute();
          const expected = new Set(ids);
          if (markers.some((marker) => !expected.has(String(marker.debug_id))))
            throw new ConflictError("Unexpected bundle marker");
          await trx
            .deleteFrom("bundle_debug_ids")
            .where("bundle_pk", "=", key)
            .execute();
          bundle.cleanupMarkersCleared = true;
          await trx
            .updateTable("bundles")
            .set({ data: JSON.stringify(bundle) })
            .where("pk", "=", key)
            .execute();
        });
      },
      finishPendingBundleCleanup: async (projectId, bundleId, cleanupId) =>
        transaction(async (trx) => {
          await dialect.lock(trx, `bundles:${projectId}`);
          const key = pk(projectId, bundleId);
          const row = await trx
            .selectFrom("bundles")
            .select("data")
            .where("pk", "=", key)
            .executeTakeFirst();
          if (!row) return;
          const bundle = decode<ArtifactBundle>(row.data);
          if (
            bundle.state !== "pending" ||
            !bundle.cleanupMarkersCleared ||
            bundle.cleanupId !== cleanupId
          )
            throw new ConflictError("Bundle cleanup claim changed");
          await trx.deleteFrom("bundles").where("pk", "=", key).execute();
        }),
      listBundles: (projectId, releaseId, cursor, limit) =>
        list("bundles", { projectId, scope: releaseId, cursor, limit }),
      deleteBundle: async (projectId, id) =>
        transaction(async (trx) => {
          await dialect.lock(trx, `bundles:${projectId}`);
          const key = pk(projectId, id);
          const row = await trx
            .selectFrom("bundles")
            .select("data")
            .where("pk", "=", key)
            .executeTakeFirst();
          if (row && decode<ArtifactBundle>(row.data).state === "pending")
            throw new ConflictError(
              "Pending bundles require the cleanup protocol",
            );
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
          .where("bundles.state", "=", "active")
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
  return withIdentifierLimits(store);
}
