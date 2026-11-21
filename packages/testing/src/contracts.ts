import {
  type ActiveStore,
  type ApiToken,
  type ApiTokenId,
  type ArchiveState,
  type ArchiveStore,
  BlobInvalidKeyError,
  type BlobStore,
  type Clock,
  ConflictError,
  type Cursor,
  type Day,
  type Delivery,
  type ErasureId,
  type ErasureRequest,
  type EventId,
  type EventPage,
  type EventPosition,
  InvalidCounterError,
  InvalidCursorError,
  InvalidQueueMessageError,
  type IssueId,
  type KV,
  type Message,
  NotFoundError,
  type Occurrence,
  type OrgId,
  type Project,
  type ProjectId,
  type ProjectKey,
  type ProjectKeyId,
  type Queue,
  type Release,
  type ReleaseId,
  type StoredEvent,
  type SubjectSelector,
  type Timestamp,
  UnsupportedQueryError,
  VersionConflictError,
} from "@errtraq/core";
import { describe, expect, it, vi } from "vitest";
import { bytes, stream } from "./shared.js";

export type Factory<T> = () => T | Promise<T>;
export interface ContractOptions {
  clock?: Clock;
  advance?: (milliseconds: number) => void | Promise<void>;
  skip?: { ttl?: boolean; delay?: boolean; push?: boolean; pull?: boolean };
}
const project = "1" as ProjectId;
const otherProject = "2" as ProjectId;
const issueId = "issue" as IssueId;
const t = (n: number): Timestamp =>
  `2024-01-01T00:00:${String(n).padStart(2, "0")}.000Z` as Timestamp;
const day = "2024-01-01" as Day;
const event = (
  id: string,
  time: number,
  overrides: Partial<StoredEvent> = {},
): StoredEvent => ({
  projectId: project,
  eventId: id as EventId,
  issueId,
  timestamp: t(time),
  receivedAt: t(time),
  level: "error",
  tags: {},
  payload: { id },
  ...overrides,
});
const occurrence = (
  id: string,
  time: number,
  fingerprint = "fp",
): Occurrence => ({
  projectId: project,
  issueId: fingerprint as IssueId,
  eventId: id as EventId,
  fingerprint,
  receivedAt: t(time),
  timestamp: t(time),
  title: "title",
  culprit: "culprit",
  level: "error",
  type: "error",
  metadata: {},
});
const erasure = (
  id: string,
): ErasureRequest & { state: "received"; selector: SubjectSelector } => ({
  id: id as ErasureId,
  projectId: project,
  version: 0,
  requestedAt: t(1),
  stateChangedAt: t(1),
  state: "received",
  selector: { kind: "userId", value: id },
});

async function record(store: ActiveStore, o: Occurrence, row?: StoredEvent) {
  return store.recordEvent(
    o,
    row ??
      event(o.eventId, Number(o.receivedAt.slice(17, 19)), {
        projectId: o.projectId,
        issueId: o.issueId,
        receivedAt: o.receivedAt,
        timestamp: o.timestamp,
      }),
  );
}
async function seed(store: ActiveStore, e: StoredEvent) {
  const o = {
    ...occurrence(e.eventId, Number(e.receivedAt.slice(17, 19)), e.issueId),
    projectId: e.projectId,
    issueId: e.issueId,
    receivedAt: e.receivedAt,
    timestamp: e.timestamp,
  };
  return record(store, o, e);
}
async function collect<T>(
  fetch: (
    cursor?: Cursor,
  ) => Promise<{ items: T[]; nextCursor: Cursor | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: Cursor | undefined;
  const visited = new Set<Cursor>();
  do {
    const p = await fetch(cursor);
    rows.push(...p.items);
    if (p.nextCursor && visited.has(p.nextCursor))
      throw new Error("Cursor repeated");
    if (p.nextCursor) visited.add(p.nextCursor);
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

async function collectEvents(
  fetch: (after?: EventPosition) => Promise<EventPage>,
): Promise<StoredEvent[]> {
  const result: StoredEvent[] = [];
  let after: EventPosition | undefined;
  for (;;) {
    const p = await fetch(after);
    result.push(...p.items);
    if (!p.hasMore) return result;
    const last = p.items.at(-1);
    if (
      !last ||
      (after?.eventId === last.eventId && after.receivedAt === last.receivedAt)
    )
      throw new Error("Invalid keyset page");
    after = { receivedAt: last.receivedAt, eventId: last.eventId };
  }
}

export function activeStoreContract(
  factory: Factory<ActiveStore>,
  options: ContractOptions = {},
): void {
  describe("ActiveStore contract", () => {
    it("puts events idempotently by project and event id", async () => {
      const s = await factory();
      const a = event("one", 1);
      expect((await seed(s, a)).inserted).toBe(true);
      expect(
        (await seed(s, { ...a, payload: { changed: true } })).inserted,
      ).toBe(false);
      expect((await seed(s, { ...a, projectId: otherProject })).inserted).toBe(
        true,
      );
      expect(await s.events.get(project, a.eventId)).toEqual(a);
      expect(await s.events.get(otherProject, a.eventId)).not.toBeNull();
    });
    it("atomically creates or bumps, reopens regressions, and tracks the latest event", async () => {
      const s = await factory();
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          record(s, occurrence(`e${String(i).padStart(2, "0")}`, i % 10)),
        ),
      );
      expect(results.filter((r) => r.isNew)).toHaveLength(1);
      expect(new Set(results.map((r) => r.issue.id)).size).toBe(1);
      const id = results[0]?.issue.id as IssueId;
      const latest = await s.issues.get(project, id);
      expect(latest?.count).toBe(40);
      expect(latest?.lastEventReceivedAt).toBe(t(9));
      expect(latest?.lastEventId).toBe("e39");
      await s.issues.update(project, id, {
        status: "resolved",
        resolvedAt: t(10),
      });
      const delayed = await record(s, {
        ...occurrence("old", 9),
        timestamp: t(20),
      });
      expect(delayed.isRegression).toBe(false);
      expect(delayed.issue.status).toBe("resolved");
      const regression = await record(s, {
        ...occurrence("new", 11),
        timestamp: t(1),
      });
      expect(regression.isNew).toBe(false);
      expect(regression.isRegression).toBe(true);
      expect(regression.issue.status).toBe("unresolved");
      expect(regression.issue.count).toBe(42);
      expect(await s.issues.get(otherProject, id)).toBeNull();
      await expect(
        s.issues.update(otherProject, id, { status: "resolved" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(regression.issue.lastEventId).toBe("new");
    });
    it("honors expiry for TTL stores", async () => {
      const store = await factory();
      if (
        store.events.capabilities.deleteStrategy !== "ttl" ||
        options.skip?.ttl
      )
        return;
      if (!options.clock || !options.advance)
        throw new Error("TTL store contract needs a controllable clock");
      const o = occurrence("ttl", 1);
      const expiresAt = new Date(
        Date.parse(options.clock.now()) + 1000,
      ).toISOString() as Timestamp;
      await record(
        store,
        o,
        event("ttl", 1, { issueId: o.issueId, expiresAt }),
      );
      expect(await store.events.get(project, o.eventId)).not.toBeNull();
      await options.advance(1000);
      await vi.waitFor(async () =>
        expect(await store.events.get(project, o.eventId)).toBeNull(),
      );
    });
    it("preserves an occurrence concurrent with an issue update", async () => {
      const store = await factory();
      const first = occurrence("first", 1);
      await record(store, first);
      await Promise.all([
        store.issues.update(project, first.issueId, {
          status: "resolved",
          resolvedAt: t(10),
        }),
        record(store, occurrence("second", 2)),
      ]);
      const issue = await store.issues.get(project, first.issueId);
      expect(issue).toMatchObject({
        count: 2,
        status: "resolved",
        lastSeen: t(2),
        lastEventId: "second",
        lastEventReceivedAt: t(2),
      });
    });
    it("atomically ignores concurrent duplicate deliveries", async () => {
      const s = await factory();
      const o = occurrence("duplicate", 1);
      const attempts = await Promise.all(
        Array.from({ length: 25 }, () => record(s, o)),
      );
      expect(attempts.filter((r) => r.inserted)).toHaveLength(1);
      expect((await s.issues.get(project, o.issueId))?.count).toBe(1);
      await s.issues.update(project, o.issueId, {
        status: "resolved",
        resolvedAt: t(2),
      });
      const retry = { ...o, receivedAt: t(3), timestamp: t(3) };
      const duplicate = await record(s, retry);
      expect(duplicate.inserted).toBe(false);
      expect(duplicate.isRegression).toBe(false);
      expect(duplicate.issue.status).toBe("resolved");
      expect(duplicate.issue.lastSeen).toBe(t(1));
    });
    it("lists issues sorted and paged without gaps and filters status/time", async () => {
      const s = await factory();
      for (let i = 0; i < 5; i++)
        for (let n = 0; n <= i; n++)
          await record(s, occurrence(`${i}-${n}`, i + 1, `fp${i}`));
      const all = await s.issues.list({
        projectId: project,
        sort: "lastSeen",
        limit: 20,
      });
      const resolved = all.items[2];
      if (!resolved) throw new Error("Missing fixture");
      await s.issues.update(project, resolved.id, {
        status: "resolved",
        resolvedAt: t(8),
      });
      for (const sort of ["firstSeen", "lastSeen", "count"] as const) {
        const rows = await collect((cursor) =>
          s.issues.list({ projectId: project, sort, cursor, limit: 2 }),
        );
        expect(rows).toHaveLength(5);
        expect(new Set(rows.map((i) => i.id)).size).toBe(5);
        expect(rows.map((i) => i[sort])).toEqual(
          [...rows.map((i) => i[sort])].sort((a, b) =>
            a < b ? 1 : a > b ? -1 : 0,
          ),
        );
      }
      expect(
        (
          await s.issues.list({
            projectId: project,
            sort: "lastSeen",
            status: "resolved",
          })
        ).items.map((i) => i.id),
      ).toEqual([resolved.id]);
      const filtered = await collect((cursor) =>
        s.issues.list({
          projectId: project,
          sort: "lastSeen",
          from: t(2),
          to: t(5),
          limit: 2,
          cursor,
        }),
      );
      expect(filtered.map((i) => i.lastSeen)).toEqual([t(4), t(3), t(2)]);
    });
    it("rejects unsupported issue filters", async () => {
      const s = await factory();
      if (!s.capabilities.textSearch)
        await expect(
          s.issues.list({
            projectId: project,
            sort: "lastSeen",
            text: "needle",
          }),
        ).rejects.toBeInstanceOf(UnsupportedQueryError);
      if (!s.capabilities.lastSeenRangeOnOtherSort)
        await expect(
          s.issues.list({ projectId: project, sort: "count", from: t(1) }),
        ).rejects.toBeInstanceOf(UnsupportedQueryError);
    });
    it("orders and pages issue events, scans exclusively before cutoff with a limit, and deletes only specified ids", async () => {
      const s = await factory();
      for (const e of [
        event("b", 2),
        event("a", 2),
        event("c", 3),
        event("d", 4),
        event("z", 1, { projectId: otherProject }),
      ])
        await seed(s, e);
      const rows = await collectEvents((after) =>
        s.events.listByIssue({
          projectId: project,
          issueId,
          limit: 2,
          after,
          order: "asc",
        }),
      );
      expect(rows.map((e) => e.eventId)).toEqual(["a", "b", "c", "d"]);
      expect(
        (
          await collectEvents((after) =>
            s.events.listByIssue({
              projectId: project,
              issueId,
              after,
              limit: 2,
            }),
          )
        ).map((e) => e.eventId),
      ).toEqual(["d", "c", "b", "a"]);
      const firstPage = await s.events.scanOlderThan(project, t(4), {
        limit: 2,
      });
      expect(firstPage.items.map((e) => e.eventId)).toEqual(["a", "b"]);
      expect(firstPage.nextCursor).not.toBeNull();
      const scanned = await collect((cursor) =>
        s.events.scanOlderThan(project, t(4), { cursor, limit: 2 }),
      );
      expect(scanned.map((e) => e.eventId)).toEqual(["a", "b", "c"]);
      const range = await collectEvents((after) =>
        s.events.listByIssue({
          projectId: project,
          issueId,
          from: t(2),
          to: t(3),
          after,
          order: "asc",
          limit: 1,
        }),
      );
      expect(range.map((e) => e.eventId)).toEqual(["a", "b"]);
      const isolated = await collectEvents((after) =>
        s.events.listByIssue({
          projectId: otherProject,
          issueId,
          after,
          limit: 1,
        }),
      );
      expect(isolated.map((e) => e.eventId)).toEqual(["z"]);
      await s.events.deleteBatch(project, [
        "b" as EventId,
        "absent" as EventId,
      ]);
      await s.events.deleteBatch(project, ["b" as EventId]);
      expect(await s.events.get(project, "b" as EventId)).toBeNull();
      expect(await s.events.get(project, "a" as EventId)).not.toBeNull();
      expect(await s.events.get(otherProject, "z" as EventId)).not.toBeNull();
    });
    for (const selector of [
      { kind: "userId", value: "subject" },
      { kind: "email", value: "subject" },
      { kind: "username", value: "subject" },
      { kind: "ipAddress", value: "subject" },
      {
        kind: "eventIds",
        eventIds: [
          "target" as EventId,
          "boundary" as EventId,
          "late" as EventId,
        ],
      },
    ] as SubjectSelector[])
      it(`deletes by ${selector.kind} without affecting later events or other projects`, async () => {
        const s = await factory();
        const user = {
          id: "subject",
          email: "subject",
          username: "subject",
          ipAddress: "subject",
        };
        for (const e of [
          event("target", 1, { user, payloadBlobKey: "overflow" }),
          event("boundary", 2, { user }),
          event("late", 3, { user }),
          event("target", 1, { user, projectId: otherProject }),
        ])
          await seed(s, e);
        const result = await s.events.deleteBySubject(
          project,
          selector,
          t(2),
          1,
        );
        expect(result.deleted).toBe(1);
        expect(result.hasMore).toBe(true);
        expect(result.payloadBlobKeys).toEqual(["overflow"]);
        const next = await s.events.deleteBySubject(project, selector, t(2), 1);
        expect(next.deleted).toBe(1);
        expect(next.hasMore).toBe(false);
        expect(next.issueCounts).toEqual([{ issueId, count: 1 }]);
        expect(next.payloadBlobKeys).toEqual([]);
        expect(await s.events.get(project, "boundary" as EventId)).toBeNull();
        expect(result.issueCounts).toEqual([{ issueId, count: 1 }]);
        const repaired = await s.issues.repairAfterErasure(project, issueId, 2);
        expect(repaired.count).toBe(1);
        expect(repaired.lastEventId).toBe("late");
        expect(await s.events.get(project, "late" as EventId)).not.toBeNull();
        await s.events.deleteBatch(project, ["late" as EventId]);
        const empty = await s.issues.repairAfterErasure(project, issueId, 1);
        expect(empty.count).toBe(0);
        expect(empty.lastEventId).toBe("late");
        expect(
          await s.events.get(otherProject, "target" as EventId),
        ).not.toBeNull();
      });
    it("uses compare-and-set for creation and competing writers, and lists erasures", async () => {
      const s = await factory();
      const state: ArchiveState = {
        projectId: project,
        version: 0,
        archivedThrough: t(0),
        seq: 0,
      };
      await s.meta.compareAndSetArchiveState(project, null, state);
      await expect(
        s.meta.compareAndSetArchiveState(project, null, state),
      ).rejects.toBeInstanceOf(VersionConflictError);
      const results = await Promise.allSettled(
        [1, 2, 3].map((seq) =>
          s.meta.compareAndSetArchiveState(project, 0, {
            ...state,
            version: 1,
            seq,
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        results
          .filter((r) => r.status === "rejected")
          .every(
            (r) =>
              r.status === "rejected" &&
              r.reason instanceof VersionConflictError,
          ),
      ).toBe(true);
      const request = erasure("erasure");
      await s.meta.compareAndSetErasureRequest(
        project,
        request.id,
        null,
        request,
      );
      const transitioned: ErasureRequest = {
        ...request,
        version: 1,
        state: "archive-masked",
        stateChangedAt: t(2),
        maskSnapshotId: "mask",
        rewriteSnapshotId: "rewrite",
        filesBlobKey: "file-list",
      };
      await s.meta.compareAndSetErasureRequest(
        project,
        request.id,
        0,
        transitioned,
      );
      expect(await s.meta.getErasureRequest(project, request.id)).toEqual(
        transitioned,
      );
      await expect(
        s.meta.compareAndSetErasureRequest(project, request.id, null, request),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(
        (
          await collect((cursor) =>
            s.meta.listErasureRequests({
              state: "archive-masked",
              cursor,
              limit: 2,
            }),
          )
        ).map((r) => r.id),
      ).toContain(request.id);
      expect(
        (await s.meta.listErasureRequests({ state: "active-purged" })).items,
      ).toHaveLength(0);
    });
    it("pages erasures by state and serializes concurrent erasure transitions", async () => {
      const store = await factory();
      const items = Array.from({ length: 4 }, (_, i) =>
        erasure(`erasure-${i}`),
      );
      for (const item of items)
        await store.meta.compareAndSetErasureRequest(
          project,
          item.id,
          null,
          item,
        );
      const foreign = { ...erasure("foreign"), projectId: otherProject };
      await store.meta.compareAndSetErasureRequest(
        otherProject,
        foreign.id,
        null,
        foreign,
      );
      expect(
        (
          await collect((cursor) =>
            store.meta.listErasureRequests({
              state: "received",
              cursor,
              limit: 2,
            }),
          )
        ).length,
      ).toBe(5);
      expect(
        (await store.meta.listErasureRequests({ projectId: otherProject }))
          .items,
      ).toEqual([foreign]);
      expect(
        (
          await collect((cursor) =>
            store.meta.listErasureRequests({
              projectId: project,
              cursor,
              limit: 2,
            }),
          )
        ).length,
      ).toBe(4);
      const firstPage = await store.meta.listErasureRequests({
        state: "received",
        projectId: project,
        limit: 2,
      });
      expect(firstPage.items.length).toBeLessThanOrEqual(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const listed = await collect((cursor) =>
        store.meta.listErasureRequests({
          state: "received",
          projectId: project,
          cursor,
          limit: 2,
        }),
      );
      expect(new Set(listed.map((item) => item.id))).toEqual(
        new Set(items.map((item) => item.id)),
      );
      const item = items[0];
      if (!item) throw new Error("Missing erasure fixture");
      const attempts = await Promise.allSettled(
        ["active-purged", "archive-masked"].map((state) =>
          store.meta.compareAndSetErasureRequest(project, item.id, 0, {
            ...item,
            version: 1,
            state,
          } as ErasureRequest),
        ),
      );
      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts
          .filter((result) => result.status === "rejected")
          .every(
            (result) =>
              result.status === "rejected" &&
              result.reason instanceof VersionConflictError,
          ),
      ).toBe(true);
    });
    it("stores and retrieves organizations and pages projects", async () => {
      const store = await factory();
      const org = { id: "org" as OrgId, slug: "org", name: "Organization" };
      await store.projects.putOrg(org);
      expect(await store.projects.getOrg(org.id)).toEqual(org);
      expect(await store.projects.getOrgBySlug(org.slug)).toEqual(org);
      expect(await store.projects.getOrgBySlug("missing")).toBeNull();
      expect(await store.projects.getOrg("missing" as OrgId)).toBeNull();
      const projects: Project[] = Array.from({ length: 4 }, (_, i) => ({
        id: `${i + 10}` as ProjectId,
        orgId: org.id,
        slug: `p${i}`,
        name: `Project ${i}`,
        retentionDays: 30,
      }));
      for (const row of projects) await store.projects.put(row);
      const firstProject = projects[0];
      if (!firstProject) throw new Error("Missing project fixture");
      expect(await store.projects.get(firstProject.id)).toEqual(firstProject);
      expect(
        await store.projects.getProjectBySlug(org.id, firstProject.slug),
      ).toEqual(firstProject);
      expect(
        await store.projects.getProjectBySlug(
          "other" as OrgId,
          firstProject.slug,
        ),
      ).toBeNull();
      expect(await store.projects.get("missing" as ProjectId)).toBeNull();
      const first = await store.projects.list(undefined, 2);
      expect(first.items.length).toBeLessThanOrEqual(2);
      expect(first.nextCursor).not.toBeNull();
      expect(
        new Set(
          (await collect((cursor) => store.projects.list(cursor, 2))).map(
            (p) => p.id,
          ),
        ),
      ).toEqual(new Set(projects.map((p) => p.id)));
    });
    it("pages releases without crossing projects", async () => {
      const store = await factory();
      const releases: Release[] = Array.from({ length: 4 }, (_, i) => ({
        id: `r${i}` as ReleaseId,
        projectId: project,
        version: `v${i}`,
        createdAt: t(i),
      }));
      for (const release of releases) await store.releases.put(release);
      const firstRelease = releases[0];
      const secondRelease = releases[1];
      if (!firstRelease || !secondRelease)
        throw new Error("Missing release fixtures");
      await store.releases.put({
        ...firstRelease,
        projectId: otherProject,
        version: "other",
      });
      const first = await store.releases.list(project, undefined, 2);
      expect(first.items.length).toBeLessThanOrEqual(2);
      expect(first.nextCursor).not.toBeNull();
      expect(
        (
          await collect((cursor) => store.releases.list(project, cursor, 2))
        ).map((r) => r.version),
      ).toEqual(releases.map((r) => r.version));
      expect(
        (await store.releases.list(otherProject, undefined, 2)).items.map(
          (r) => r.version,
        ),
      ).toEqual(["other"]);
      expect(
        await store.releases.get(otherProject, secondRelease.id),
      ).toBeNull();
    });
    it("uses stable keysets when earlier events are inserted or removed", async () => {
      const store = await factory();
      for (let i = 1; i <= 4; i++)
        await record(store, occurrence(`e${i}`, i, `issue${i}`));
      const first = await store.events.scanOlderThan(project, t(9), {
        limit: 2,
      });
      expect(first.items.map((e) => e.eventId)).toEqual(["e1", "e2"]);
      expect(first.nextCursor).not.toBeNull();
      await store.events.deleteBatch(project, ["e1" as EventId]);
      await record(store, occurrence("earlier", 0, "new"));
      const second = await store.events.scanOlderThan(project, t(9), {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((e) => e.eventId)).toEqual(["e3", "e4"]);
    });
    it("does not repeat issues when earlier entries are inserted or bumped", async () => {
      const store = await factory();
      for (let i = 1; i <= 4; i++)
        await record(store, occurrence(`issue-event${i}`, i, `issue${i}`));
      const first = await store.issues.list({
        projectId: project,
        sort: "lastSeen",
        limit: 2,
      });
      expect(first.nextCursor).not.toBeNull();
      await record(store, occurrence("new-event", 7, "new-issue"));
      await record(store, occurrence("bump", 8, "issue4"));
      const second = await store.issues.list({
        projectId: project,
        sort: "lastSeen",
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((v) => v.fingerprint)).toEqual([
        "issue2",
        "issue1",
      ]);
    });
    it("rejects malformed cursors and invalid page limits", async () => {
      const store = await factory();
      for (const value of ["abc", "1.5", ""] as Cursor[]) {
        await expect(store.projects.list(value, 2)).rejects.toBeInstanceOf(
          InvalidCursorError,
        );
        await expect(
          store.issues.list({
            projectId: project,
            sort: "lastSeen",
            cursor: value,
            limit: 2,
          }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        await expect(
          store.events.scanOlderThan(project, t(9), {
            cursor: value,
            limit: 2,
          }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        await expect(
          store.releases.list(project, value, 2),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        await expect(
          store.releases.listBundles(project, "release" as ReleaseId, value, 2),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        await expect(
          store.meta.listErasureRequests({ cursor: value, limit: 2 }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
      }
      for (const limit of [0, -1, 1.5, 10001]) {
        await expect(
          store.projects.list(undefined, limit),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        await expect(
          store.issues.list({ projectId: project, sort: "lastSeen", limit }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        await expect(
          store.events.scanOlderThan(project, t(9), { limit }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
        await expect(
          store.events.listByIssue({ projectId: project, limit }),
        ).rejects.toBeInstanceOf(InvalidCursorError);
      }
    });
    it("rejects duplicate natural keys owned by another record", async () => {
      const s = await factory();
      const org = { id: "org-a" as OrgId, slug: "same", name: "one" };
      await s.projects.putOrg(org);
      await expect(
        s.projects.putOrg({ ...org, id: "org-b" as OrgId }),
      ).rejects.toBeInstanceOf(ConflictError);
      const p: Project = {
        id: project,
        orgId: org.id,
        slug: "same",
        name: "one",
        retentionDays: 30,
      };
      await s.projects.put(p);
      await expect(
        s.projects.put({ ...p, id: otherProject }),
      ).rejects.toBeInstanceOf(ConflictError);
      const key = {
        id: "k1" as import("@errtraq/core").ProjectKeyId,
        projectId: project,
        publicKey: "pub",
      };
      await s.projects.putKey(key);
      await expect(
        s.projects.putKey({ ...key, id: "k2" as typeof key.id }),
      ).rejects.toBeInstanceOf(ConflictError);
      const token: ApiToken = {
        id: "a" as ApiTokenId,
        orgId: org.id,
        tokenHash: "hash",
        scopes: [],
      };
      await s.projects.putToken(token);
      await expect(
        s.projects.putToken({ ...token, id: "b" as ApiTokenId }),
      ).rejects.toBeInstanceOf(ConflictError);
      const release: Release = {
        id: "r1" as ReleaseId,
        projectId: project,
        version: "v",
        createdAt: t(1),
      };
      await s.releases.put(release);
      await expect(
        s.releases.put({ ...release, id: "r2" as ReleaseId }),
      ).rejects.toBeInstanceOf(ConflictError);
      await s.projects.putOrg({ ...org, name: "updated" });
      expect((await s.projects.getOrg(org.id))?.name).toBe("updated");
    });
    it("looks up matching issue IDs across projects", async () => {
      const s = await factory();
      const item = event("global", 1, { issueId: "global-issue" as IssueId });
      await s.recordEvent(
        { ...occurrence("global", 1), issueId: item.issueId },
        item,
      );
      expect(
        (await s.issues.getById(item.issueId)).map((issue) => issue.id),
      ).toEqual([item.issueId]);
      const another = { ...item, projectId: otherProject };
      await s.recordEvent(
        {
          ...occurrence("global", 1),
          projectId: otherProject,
          issueId: item.issueId,
        },
        another,
      );
      expect(
        (await s.issues.getById(item.issueId))
          .map((issue) => issue.projectId)
          .sort(),
      ).toEqual([project, otherProject].sort());
      expect(await s.issues.getById("missing" as IssueId)).toEqual([]);
    });
    it("atomically creates one initial active project key", async () => {
      const s = await factory();
      const candidates: ProjectKey[] = Array.from({ length: 8 }, (_, i) => ({
        id: `key-${i}` as ProjectKeyId,
        projectId: project,
        publicKey: `public-${i}`,
      }));
      const results = await Promise.all(
        candidates.map((key) => s.projects.getOrCreateActiveKey(key)),
      );
      expect(new Set(results.map((key) => key.publicKey)).size).toBe(1);
      expect(await s.projects.listKeys(project)).toHaveLength(1);
    });
    it("looks up keys, hashed tokens, releases and debug ids", async () => {
      const s = await factory();
      const key = {
        id: "key",
        projectId: project,
        publicKey: "public",
      } as Parameters<typeof s.projects.putKey>[0];
      const token: ApiToken = {
        id: "token" as ApiTokenId,
        orgId: "org" as OrgId,
        tokenHash: "hash",
        scopes: [],
      };
      const release = {
        id: "release",
        projectId: project,
        version: "1",
        createdAt: t(1),
      } as Parameters<typeof s.releases.put>[0];
      const bundle = {
        id: "bundle",
        projectId: project,
        releaseId: release.id,
        blobKey: "bundle-key",
        debugIds: ["debug"],
      } as Parameters<typeof s.releases.putBundle>[0];
      await s.projects.putKey(key);
      await s.projects.putToken(token);
      await s.releases.put(release);
      await s.releases.putBundle(bundle);
      expect(await s.projects.getKey("public")).toEqual(key);
      expect(await s.projects.listKeys(project)).toEqual([key]);
      expect(await s.projects.listKeys(otherProject)).toEqual([]);
      expect(await s.projects.getTokenByHash("hash")).toEqual(token);
      expect(await s.projects.getTokenByHash("token")).toBeNull();
      const extraBundle = {
        ...bundle,
        id: "bundle-extra" as typeof bundle.id,
        debugIds: ["extra-debug"],
      };
      await s.releases.putBundle(extraBundle);
      expect(
        (await s.releases.listBundles(project, release.id, undefined, 1))
          .nextCursor,
      ).not.toBeNull();
      expect(
        new Set(
          (
            await collect((cursor) =>
              s.releases.listBundles(project, release.id, cursor, 1),
            )
          ).map((b) => b.id),
        ),
      ).toEqual(new Set([bundle.id, extraBundle.id]));
      await s.releases.deleteBundle(project, extraBundle.id);
      expect(await s.releases.get(project, release.id)).toEqual(release);
      expect(
        await s.releases.getReleaseByVersion(project, release.version),
      ).toEqual(release);
      expect(
        await s.releases.getReleaseByVersion(otherProject, release.version),
      ).toBeNull();
      expect(
        (await s.releases.listBundles(project, release.id, undefined, 1)).items,
      ).toEqual([bundle]);
      expect(
        (await s.releases.listBundles(otherProject, release.id, undefined, 1))
          .items,
      ).toEqual([]);
      expect(await s.releases.findBundleByDebugId(project, "debug")).toEqual(
        bundle,
      );
      expect(
        await s.releases.findBundleByDebugId(otherProject, "debug"),
      ).toBeNull();
      await s.releases.deleteBundle(otherProject, bundle.id);
      expect(await s.releases.findBundleByDebugId(project, "debug")).toEqual(
        bundle,
      );
      await s.releases.deleteBundle(project, bundle.id);
      await s.releases.deleteBundle(project, bundle.id);
      expect(await s.releases.findBundleByDebugId(project, "debug")).toBeNull();
    });
  });
}

export interface QueueContractOptions extends ContractOptions {
  /** Deliver a platform event to push.handle; the source applies acknowledgements. */
  deliverPush?: (
    queue: Queue,
    handler: (
      batch: Delivery[],
    ) => Promise<import("@errtraq/core").BatchResult>,
  ) => Promise<void>;
}

export function queueContract(
  factory: Factory<Queue>,
  options: QueueContractOptions = {},
): void {
  describe("Queue contract", () => {
    it("exposes exactly the consumer shapes declared by capabilities", async () => {
      const q = await factory();
      expect(!!q.pull).toBe(q.capabilities.delivery !== "push");
      expect(!!q.push).toBe(q.capabilities.delivery !== "pull");
    });
    it("retries unacknowledged pull deliveries with incremented attempts, then acknowledges", async () => {
      const q = await factory();
      if (q.capabilities.delivery === "push" || options.skip?.pull) return;
      if (!q.pull) throw new Error("Missing pull source");
      const seen: Delivery[] = [];
      const controller = new AbortController();
      const running = q.pull.run(async (batch) => {
        seen.push(...batch);
        return batch.map((d) => ({
          deliveryId: d.id,
          action: d.attempt === 1 ? ("retry" as const) : ("ack" as const),
        }));
      }, controller.signal);
      try {
        await q.producer.send("contract", [{ key: "k", body: { value: 1 } }]);
        await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
        expect(seen[0]?.message).toEqual({ key: "k", body: { value: 1 } });
        expect(seen[1]?.message).toEqual(seen[0]?.message);
        expect(seen[1]?.attempt).toBeGreaterThan(seen[0]?.attempt ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(seen).toHaveLength(2);
      } finally {
        controller.abort();
        await running;
      }
    });
    it("rejects non-JSON message bodies before publishing", async () => {
      const q = await factory();
      for (const body of [
        new Uint8Array([1]),
        new ArrayBuffer(1),
        new Date(),
        NaN,
        Infinity,
        { x: undefined },
        { toJSON: () => 1 },
        [undefined],
      ])
        await expect(
          q.producer.send("contract", [{ key: "bad", body }]),
        ).rejects.toBeInstanceOf(InvalidQueueMessageError);
    });
    it("validates a batch before publishing any message", async () => {
      const q = await factory();
      for (const delaySec of [-1, Number.NaN, Number.POSITIVE_INFINITY])
        await expect(
          q.producer.send("contract", [{ key: "x", body: null }], { delaySec }),
        ).rejects.toThrow();
      await expect(
        q.producer.send("contract", [
          { key: "good", body: 1 },
          { key: "bad", body: () => {} },
        ]),
      ).rejects.toThrow();
      await expect(
        q.producer.send("contract", [
          { key: "large", body: "x".repeat(q.capabilities.maxBytes) },
        ]),
      ).rejects.toThrow();
      if (q.pull && !options.skip?.pull) {
        const controller = new AbortController();
        const seen: Delivery[] = [];
        const running = q.pull.run(async (batch) => {
          seen.push(...batch);
          return batch.map((d) => ({
            deliveryId: d.id,
            action: "ack" as const,
          }));
        }, controller.signal);
        try {
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(seen).toEqual([]);
        } finally {
          controller.abort();
          await running;
        }
      }
    });
    it("serves other messages and aborts when one handler repeatedly throws", async () => {
      const q = await factory();
      if (q.capabilities.delivery === "push" || options.skip?.pull) return;
      if (!q.pull) throw new Error("Missing pull source");
      const controller = new AbortController();
      const seen: string[] = [];
      const running = q.pull.run(async (batch) => {
        const first = batch[0];
        if (!first) return [];
        seen.push(first.message.key);
        if (first.message.key === "bad") throw new Error("failure");
        return batch.map((d) => ({ deliveryId: d.id, action: "ack" as const }));
      }, controller.signal);
      try {
        await q.producer.send("contract", [
          { key: "bad", body: null },
          { key: "good", body: null },
        ]);
        await vi.waitFor(() => expect(seen).toContain("good"), {
          timeout: 1000,
        });
      } finally {
        controller.abort();
        await running;
      }
    });
    it("preserves distinct topics through pull delivery", async () => {
      const q = await factory();
      if (q.capabilities.delivery === "push" || options.skip?.pull) return;
      if (!q.pull) throw new Error("Missing pull source");
      const seen: Delivery[] = [];
      const controller = new AbortController();
      const running = q.pull.run(async (batch) => {
        seen.push(...batch);
        return batch.map((d) => ({ deliveryId: d.id, action: "ack" as const }));
      }, controller.signal);
      try {
        await q.producer.send("ingest", [{ key: "one", body: 1 }]);
        await q.producer.send("archive.project", [{ key: "two", body: 2 }]);
        await vi.waitFor(() => expect(seen).toHaveLength(2));
        expect(
          Object.fromEntries(seen.map((d) => [d.message.key, d.topic])),
        ).toEqual({ one: "ingest", two: "archive.project" });
      } finally {
        controller.abort();
        await running;
      }
    });
    it("preserves distinct topics through push delivery", async () => {
      const q = await factory();
      if (q.capabilities.delivery === "pull" || options.skip?.push) return;
      if (!q.push || !options.deliverPush)
        throw new Error("Push contract needs a platform delivery driver");
      await q.producer.send("ingest", [{ key: "one", body: 1 }]);
      await q.producer.send("archive.project", [{ key: "two", body: 2 }]);
      const seen: Delivery[] = [];
      const handler = async (batch: Delivery[]) => {
        seen.push(...batch);
        return batch.map((d) => ({ deliveryId: d.id, action: "ack" as const }));
      };
      await options.deliverPush(q, handler);
      await options.deliverPush(q, handler);
      expect(
        Object.fromEntries(seen.map((d) => [d.message.key, d.topic])),
      ).toEqual({ one: "ingest", two: "archive.project" });
    });
    it("honors producer delay when supported", async () => {
      const q = await factory();
      if (
        !q.capabilities.delay ||
        q.capabilities.delivery === "push" ||
        options.skip?.delay ||
        options.skip?.pull
      )
        return;
      if (!q.pull || !options.advance)
        throw new Error("Delay test needs pull and a controllable clock");
      const seen: Message[] = [];
      const controller = new AbortController();
      const running = q.pull.run(async (batch) => {
        seen.push(...batch.map((d) => d.message));
        return batch.map((d) => ({ deliveryId: d.id, action: "ack" as const }));
      }, controller.signal);
      try {
        await q.producer.send("contract", [{ key: "delayed", body: null }], {
          delaySec: 10,
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(seen).toHaveLength(0);
        await options.advance(10000);
        await vi.waitFor(() => expect(seen).toHaveLength(1));
      } finally {
        controller.abort();
        await running;
      }
    });
    it("redelivers handler failures and respects retry delay", async () => {
      const q = await factory();
      if (q.capabilities.delivery === "push" || options.skip?.pull) return;
      if (!q.pull) throw new Error("Missing pull source");
      const seen: Delivery[] = [];
      const controller = new AbortController();
      const running = q.pull.run(async (batch) => {
        seen.push(...batch);
        if (seen.length === 1) throw new Error("transient failure");
        return batch.map((d) => ({
          deliveryId: d.id,
          action:
            seen.length === 2 && q.capabilities.delay && !options.skip?.delay
              ? ("retry" as const)
              : ("ack" as const),
          ...(seen.length === 2 && q.capabilities.delay && !options.skip?.delay
            ? { delaySec: 10 }
            : {}),
        }));
      }, controller.signal);
      try {
        await q.producer.send("contract", [{ key: "failure", body: null }]);
        await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
        expect(seen[1]?.attempt).toBeGreaterThan(seen[0]?.attempt ?? 0);
        if (q.capabilities.delay && !options.skip?.delay) {
          if (!options.advance)
            throw new Error("Retry delay test needs a controllable clock");
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(seen).toHaveLength(2);
          await options.advance(10000);
          await vi.waitFor(() => expect(seen).toHaveLength(3));
        }
      } finally {
        controller.abort();
        await running;
      }
    });
    it("supports retry and acknowledgement through push delivery", async () => {
      const q = await factory();
      if (q.capabilities.delivery === "pull" || options.skip?.push) return;
      if (!q.push || !options.deliverPush)
        throw new Error("Push contract needs a platform delivery driver");
      await q.producer.send("contract", [{ key: "push", body: 1 }]);
      const seen: Delivery[] = [];
      const handler = async (batch: Delivery[]) => {
        seen.push(...batch);
        return batch.map((d) => ({
          deliveryId: d.id,
          action: d.attempt === 1 ? ("retry" as const) : ("ack" as const),
        }));
      };
      await options.deliverPush(q, handler);
      await options.deliverPush(q, handler);
      expect(seen).toHaveLength(2);
      expect(seen[1]?.message).toEqual(seen[0]?.message);
      expect(seen[1]?.attempt).toBeGreaterThan(seen[0]?.attempt ?? 0);
      await options.deliverPush(q, handler);
      expect(seen).toHaveLength(2);
    });
  });
}

export function blobStoreContract(
  factory: Factory<BlobStore>,
  _options: ContractOptions = {},
): void {
  describe("BlobStore contract", () => {
    it("rejects nonportable object keys on every key operation", async () => {
      const b = await factory();
      for (const key of [
        "",
        ".",
        "a/../b",
        "a/./b",
        "a\u0001b",
        "é".repeat(513),
      ]) {
        for (const action of [
          () => b.put(key, new Uint8Array()),
          () => b.get(key),
          () => b.head(key),
          () => b.delete(key),
          ...(b.presign
            ? [() => b.presign?.(key, { method: "GET", expiresInSec: 60 })]
            : []),
        ])
          await expect(action()).rejects.toBeInstanceOf(BlobInvalidKeyError);
      }
    });
    it("stores byte arrays and streams, reports metadata, and deletes idempotently", async () => {
      const b = await factory();
      const first = new TextEncoder().encode("first");
      const second = new TextEncoder().encode("second");
      await b.put("p/a", first, {
        contentType: "text/plain",
        size: first.length,
      });
      await b.put("p/b", stream(second), { size: second.length });
      expect(await b.head("p/a")).toMatchObject({
        size: 5,
        contentType: "text/plain",
      });
      const one = await b.get("p/a"),
        two = await b.get("p/b");
      if (!one || !two) throw new Error("Missing blob");
      expect(await bytes(one)).toEqual(first);
      expect(await bytes(two)).toEqual(second);
      await b.delete("p/a");
      await b.delete("p/a");
      expect(await b.get("p/a")).toBeNull();
      expect(await b.head("p/a")).toBeNull();
      expect(await b.get("missing")).toBeNull();
    });
    it("overwrites an existing blob and its metadata", async () => {
      const b = await factory();
      await b.put("key", new TextEncoder().encode("old"), {
        contentType: "text/plain",
      });
      const replacement = new TextEncoder().encode("new value");
      await b.put("key", replacement, {
        contentType: "application/json",
        size: replacement.length,
      });
      expect(await b.head("key")).toMatchObject({
        size: replacement.length,
        contentType: "application/json",
      });
      const body = await b.get("key");
      if (!body) throw new Error("Missing blob");
      expect(await bytes(body)).toEqual(replacement);
    });
    it("reads byte ranges", async () => {
      const b = await factory();
      await b.put("range", new TextEncoder().encode("abcdef"));
      const part = await b.get("range", { range: { offset: 2, length: 3 } });
      if (!part) throw new Error("Missing blob");
      expect(new TextDecoder().decode(await bytes(part))).toBe("cde");
      const tail = await b.get("range", { range: { offset: 4 } });
      if (!tail) throw new Error("Missing blob");
      expect(new TextDecoder().decode(await bytes(tail))).toBe("ef");
    });
    it("orders non-ASCII keys by UTF-8 bytes", async () => {
      const b = await factory();
      for (const key of ["p/😀", "p/～", "p/a"])
        await b.put(key, new Uint8Array());
      const rows = await collect((cursor) => b.list("p/", cursor, 1));
      expect(rows).toEqual(["p/a", "p/～", "p/😀"]);
    });
    it("rejects malformed cursors and invalid limits", async () => {
      const b = await factory();
      await expect(b.list("p/", "abc" as Cursor, 1)).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
      for (const limit of [0, -1, 1.5, 10001])
        await expect(b.list("p/", undefined, limit)).rejects.toBeInstanceOf(
          InvalidCursorError,
        );
    });
    it("lists a prefix across all pages without duplicates", async () => {
      const b = await factory();
      for (const key of ["p/3", "p/1", "p/2", "p/4", "other"])
        await b.put(key, new Uint8Array());
      const firstPage = await b.list("p/", undefined, 2);
      expect(firstPage.items.length).toBeLessThanOrEqual(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const keys = await collect((cursor) => b.list("p/", cursor, 2));
      expect(keys).toEqual(["p/1", "p/2", "p/3", "p/4"]);
    });
  });
}

export function kvContract(
  factory: Factory<KV>,
  options: ContractOptions = {},
): void {
  describe("KV contract", () => {
    it("stores, replaces, retrieves and deletes values", async () => {
      const kv = await factory();
      expect(await kv.get("k")).toBeNull();
      await kv.put("k", "one");
      await kv.put("k", "two");
      expect(await kv.get("k")).toBe("two");
      await kv.delete("k");
      await kv.delete("k");
      expect(await kv.get("k")).toBeNull();
    });
    it("atomically increments in parallel", async () => {
      const kv = await factory();
      const results = await Promise.all(
        Array.from({ length: 50 }, () => kv.increment("counter", 1)),
      );
      expect(new Set(results).size).toBe(50);
      expect(await kv.get("counter")).toBe("50");
      expect(await kv.increment("counter", -2)).toBe(48);
    });
    it("rejects non-decimal counter contents", async () => {
      const kv = await factory();
      for (const value of ["", " 5 ", "0x10", "1.5", "9007199254740993"]) {
        await kv.put("counter", value);
        await expect(kv.increment("counter", 1)).rejects.toBeInstanceOf(
          InvalidCounterError,
        );
        expect(await kv.get("counter")).toBe(value);
      }
    });
    it("expires values at TTL without affecting permanent values", async () => {
      if (options.skip?.ttl) return;
      if (!options.advance)
        throw new Error("TTL contract needs a controllable clock");
      const kv = await factory();
      await kv.put("expiring", "v", { ttlSec: 10 });
      await kv.put("permanent", "p");
      await options.advance(9999);
      expect(await kv.get("expiring")).toBe("v");
      await options.advance(1);
      expect(await kv.get("expiring")).toBeNull();
      expect(await kv.get("permanent")).toBe("p");
    });
  });
}

export interface ArchiveContractOptions extends ContractOptions {
  stage: (
    store: ArchiveStore,
    key: string,
    events: StoredEvent[],
  ) => Promise<void>;
}

export function archiveStoreContract(
  factory: Factory<ArchiveStore>,
  options: ArchiveContractOptions,
): void {
  describe("ArchiveStore contract", () => {
    const batch = {
      batchId: "batch",
      stagedKey: "stage",
      dayRange: [day, day] as [Day, Day],
    };
    async function setup() {
      const store = await factory();
      const data = [
        event("b", 2, { user: { email: "subject@example.org" } }),
        event("a", 2, { user: { email: "subject@example.org" } }),
        event("c", 3, { issueId: "other-issue" as IssueId }),
        event("d", 4),
      ];
      await options.stage(store, batch.stagedKey, data);
      return store;
    }
    it("probes and safely repeats the same append", async () => {
      const a = await setup();
      expect(await a.hasBatch("unknown", batch.dayRange)).toBe(false);
      expect(await a.hasBatch(batch.batchId, batch.dayRange)).toBe(false);
      const [first, concurrent] = await Promise.all([
        a.append(batch),
        a.append(batch),
      ]);
      expect(concurrent).toEqual(first);
      expect(first.rowCount).toBe(4);
      expect(await a.hasBatch(batch.batchId, batch.dayRange)).toBe(true);
      expect(await a.append(batch)).toEqual(first);
      expect(
        (
          await collectEvents((after) =>
            a.query({ projectId: project, limit: 2, after, order: "asc" }),
          )
        ).map((e) => e.eventId),
      ).toEqual(["a", "b", "c", "d"]);
      expect(
        (
          await collectEvents((after) =>
            a.query({ projectId: project, after, limit: 2 }),
          )
        ).map((e) => e.eventId),
      ).toEqual(["d", "c", "b", "a"]);
    });
    it("filters issue and half-open time ranges and isolates projects", async () => {
      const a = await setup();
      await a.append(batch);
      const otherBatch = {
        batchId: "other",
        stagedKey: "other-stage",
        dayRange: [day, day] as [Day, Day],
      };
      await options.stage(a, otherBatch.stagedKey, [
        event("foreign", 2, { projectId: otherProject }),
      ]);
      await a.append(otherBatch);
      const rows = await collectEvents((after) =>
        a.query({
          projectId: project,
          issueId,
          from: t(2),
          to: t(4),
          limit: 1,
          after,
          order: "asc",
        }),
      );
      expect(rows.map((e) => e.eventId)).toEqual(["a", "b"]);
      expect(
        (await a.query({ projectId: otherProject, limit: 2 })).items.map(
          (e) => e.eventId,
        ),
      ).toEqual(["foreign"]);
      expect(await a.getEvent(project, "foreign" as EventId)).toBeNull();
      expect(await a.getEvent(otherProject, "b" as EventId)).toBeNull();
      expect(await a.getEvent(project, "b" as EventId, t(2))).toMatchObject({
        eventId: "b",
      });
    });
    for (const selector of [
      { kind: "email", value: "subject@example.org" },
      { kind: "eventIds", eventIds: ["a" as EventId, "b" as EventId] },
    ] satisfies SubjectSelector[]) {
      it(`masks and hard-erases by ${selector.kind} while preserving other rows`, async () => {
        const a = await setup();
        await a.append(batch);
        const deleted = await a.deleteWhere({
          erasureId: "erasure" as ErasureId,
          projectId: project,
          selector,
        });
        expect(deleted.rowsDeleted).toBe(2);
        expect(deleted.files.length).toBeGreaterThan(0);
        expect(await a.getEvent(project, "a" as EventId)).toBeNull();
        expect(
          (
            await collectEvents((after) =>
              a.query({ projectId: project, after, limit: 1, order: "asc" }),
            )
          ).map((e) => e.eventId),
        ).toEqual(["c", "d"]);
        await a.hardErase({
          erasureId: "erasure" as ErasureId,
          files: deleted.files,
        });
        await a.expireSnapshots(t(5));
        expect(
          (
            await collectEvents((after) =>
              a.query({ projectId: project, after, limit: 1, order: "asc" }),
            )
          ).map((e) => e.eventId),
        ).toEqual(["c", "d"]);
        expect(await a.getEvent(project, "b" as EventId)).toBeNull();
      });
    }
  });
}
