import {
  type ActiveStore,
  type ApiToken,
  type ApiTokenId,
  type ArchiveState,
  type ArchiveStore,
  type BlobStore,
  type Clock,
  type Cursor,
  type Day,
  type Delivery,
  type ErasureId,
  type ErasureRequest,
  type EventId,
  type IssueId,
  type KV,
  type Message,
  NotFoundError,
  type Occurrence,
  type OrgId,
  type Project,
  type ProjectId,
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
  /** A tag key known not to be indexed by the implementation under test. */
  unindexedTagKey?: string;
  skip?: { ttl?: boolean; delay?: boolean; push?: boolean; pull?: boolean };
}
const project = "project" as ProjectId;
const otherProject = "other" as ProjectId;
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
const erasure = (id: string): ErasureRequest => ({
  id: id as ErasureId,
  projectId: project,
  version: 0,
  requestedAt: t(1),
  state: "received",
  selector: { kind: "userId", value: id },
});

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

export function activeStoreContract(
  factory: Factory<ActiveStore>,
  options: ContractOptions = {},
): void {
  describe("ActiveStore contract", () => {
    it("puts events idempotently by project and event id", async () => {
      const s = await factory();
      const a = event("one", 1);
      expect(await s.events.put(a)).toEqual({ inserted: true });
      expect(await s.events.put({ ...a, payload: { changed: true } })).toEqual({
        inserted: false,
      });
      expect(await s.events.put({ ...a, projectId: otherProject })).toEqual({
        inserted: true,
      });
      expect(await s.events.get(project, a.eventId)).toEqual(a);
      expect(await s.events.get(otherProject, a.eventId)).not.toBeNull();
    });
    it("atomically creates or bumps, reopens regressions, and tracks the latest event", async () => {
      const s = await factory();
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          s.issues.recordOccurrence(
            occurrence(`e${String(i).padStart(2, "0")}`, i % 10),
          ),
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
      const delayed = await s.issues.recordOccurrence({
        ...occurrence("old", 9),
        timestamp: t(20),
      });
      expect(delayed.isRegression).toBe(false);
      expect(delayed.issue.status).toBe("resolved");
      const regression = await s.issues.recordOccurrence({
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
    it("lists issues sorted and paged without gaps and filters status/time", async () => {
      const s = await factory();
      for (let i = 0; i < 5; i++)
        for (let n = 0; n <= i; n++)
          await s.issues.recordOccurrence(
            occurrence(`${i}-${n}`, i + 1, `fp${i}`),
          );
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
      if (s.capabilities.tagFilter === "indexed-only")
        await expect(
          s.issues.list({
            projectId: project,
            sort: "lastSeen",
            tags: {
              [options.unindexedTagKey ?? "unindexed-contract-key"]: "v",
            },
          }),
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
        await s.events.put(e);
      const rows = await collect((cursor) =>
        s.events.listByIssue({ projectId: project, issueId, limit: 2, cursor }),
      );
      expect(rows.map((e) => e.eventId)).toEqual(["a", "b", "c", "d"]);
      const firstPage = await s.events.scanOlderThan(project, t(4), {
        limit: 2,
      });
      expect(firstPage.items.map((e) => e.eventId)).toEqual(["a", "b"]);
      expect(firstPage.nextCursor).not.toBeNull();
      const scanned = await collect((cursor) =>
        s.events.scanOlderThan(project, t(4), { cursor, limit: 2 }),
      );
      expect(scanned.map((e) => e.eventId)).toEqual(["a", "b", "c"]);
      const range = await collect((cursor) =>
        s.events.listByIssue({
          projectId: project,
          issueId,
          from: t(2),
          to: t(3),
          cursor,
          limit: 1,
        }),
      );
      expect(range.map((e) => e.eventId)).toEqual(["a", "b"]);
      const isolated = await collect((cursor) =>
        s.events.listByIssue({
          projectId: otherProject,
          issueId,
          cursor,
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
          event("target", 1, { user }),
          event("boundary", 2, { user }),
          event("late", 3, { user }),
          event("target", 1, { user, projectId: otherProject }),
        ])
          await s.events.put(e);
        const result = await s.events.deleteBySubject(project, selector, t(2));
        expect(result.deleted).toBe(2);
        expect(await s.events.get(project, "boundary" as EventId)).toBeNull();
        expect(result.issueIds).toEqual([issueId]);
        expect(await s.events.get(project, "late" as EventId)).not.toBeNull();
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
      await expect(
        s.meta.compareAndSetErasureRequest(project, request.id, null, request),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(
        (
          await collect((cursor) =>
            s.meta.listErasureRequests("received", cursor, 2),
          )
        ).map((r) => r.id),
      ).toContain(request.id);
      expect(
        (await s.meta.listErasureRequests("archive-masked")).items,
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
      const firstPage = await store.meta.listErasureRequests(
        "received",
        undefined,
        2,
      );
      expect(firstPage.items.length).toBeLessThanOrEqual(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const listed = await collect((cursor) =>
        store.meta.listErasureRequests("received", cursor, 2),
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
      expect(await store.projects.getOrg("missing" as OrgId)).toBeNull();
      const projects: Project[] = Array.from({ length: 4 }, (_, i) => ({
        id: `p${i}` as ProjectId,
        orgId: org.id,
        slug: `p${i}`,
        name: `Project ${i}`,
        retentionDays: 30,
      }));
      for (const row of projects) await store.projects.put(row);
      const firstProject = projects[0];
      if (!firstProject) throw new Error("Missing project fixture");
      expect(await store.projects.get(firstProject.id)).toEqual(firstProject);
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
      expect(await s.projects.getTokenByHash("hash")).toEqual(token);
      expect(await s.projects.getTokenByHash("token")).toBeNull();
      expect(await s.releases.get(project, release.id)).toEqual(release);
      expect(await s.releases.findBundleByDebugId(project, "debug")).toEqual(
        bundle,
      );
      expect(
        await s.releases.findBundleByDebugId(otherProject, "debug"),
      ).toBeNull();
    });
  });
}

export interface QueueContractOptions extends ContractOptions {
  /** Drive a platform event through push.toBatch, handler, and push.toResponse. */
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
      const first = await a.append(batch);
      expect(first.rowCount).toBe(4);
      expect(await a.hasBatch(batch.batchId, batch.dayRange)).toBe(true);
      expect(await a.append(batch)).toEqual(first);
      expect(
        (
          await collect((cursor) =>
            a.query({ projectId: project, limit: 2, cursor }),
          )
        ).map((e) => e.eventId),
      ).toEqual(["a", "b", "c", "d"]);
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
      const rows = await collect((cursor) =>
        a.query({
          projectId: project,
          issueId,
          from: t(2),
          to: t(4),
          limit: 1,
          cursor,
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
            await collect((cursor) =>
              a.query({ projectId: project, cursor, limit: 1 }),
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
            await collect((cursor) =>
              a.query({ projectId: project, cursor, limit: 1 }),
            )
          ).map((e) => e.eventId),
        ).toEqual(["c", "d"]);
        expect(await a.getEvent(project, "b" as EventId)).toBeNull();
      });
    }
  });
}
