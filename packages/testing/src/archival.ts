import {
  type ActiveStore,
  ARCHIVE_PROJECT_TOPIC,
  ArchiveBusyError,
  type ArchiveStore,
  ArchiveWorker,
  type Cursor,
  type EventId,
  type IssueId,
  type Message,
  type OrgId,
  type Project,
  type ProjectId,
  purgeProjectArchive,
  type QueueProducer,
  runArchiveHousekeeping,
  type StoredEvent,
  type Timestamp,
  UnsupportedQueryError,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import {
  FaultInjector,
  faultyActiveStore,
  faultyArchiveStore,
  faultyBlobStore,
  InjectedFault,
} from "./faults.js";
import { MemoryArchiveStore, MemoryBlobStore } from "./memory-other.js";
import { FakeClock } from "./shared.js";

const projectId = "1" as ProjectId;
const TIMEOUT_MS = 60_000;
const NOW = "2024-03-01T00:00:00.000Z";
const BASE = Date.parse("2024-01-01T00:00:00.000Z");
const stamp = (ms: number) => new Date(ms).toISOString() as Timestamp;

/** Sentry-like events: `old` ones are below the 1 day hot-tier cutoff, `recent` ones are not. */
export interface ArchivalFixture {
  old: StoredEvent[];
  recent: StoredEvent[];
}

function eventAt(id: string, receivedAt: Timestamp): StoredEvent {
  return {
    projectId,
    eventId: id as EventId,
    issueId: "issue" as IssueId,
    timestamp: receivedAt,
    receivedAt,
    level: "error",
    tags: { id },
    payload: { id },
  };
}

async function seed(store: ActiveStore, event: StoredEvent) {
  await store.recordEvent(
    {
      projectId,
      issueId: event.issueId,
      eventId: event.eventId,
      fingerprint: "fp",
      timestamp: event.timestamp,
      receivedAt: event.receivedAt,
      title: "title",
      culprit: "",
      level: "error",
      type: "error",
      metadata: {},
    },
    event,
  );
}

export interface Scenario {
  store: ActiveStore;
  blobs: MemoryBlobStore;
  archive: ArchiveStore;
  clock: FakeClock;
  sent: { topic: string; messages: Message[] }[];
  fixture: ArchivalFixture;
  /** A worker over (optionally fault-wrapped) ports; owner ids default to `w1`, `w2`, ... */
  worker(options?: {
    faults?: FaultInjector;
    archive?: ArchiveStore;
    owner?: string;
    maxRows?: number;
  }): ArchiveWorker;
  /** Add an old event after the scenario was seeded (a late event). */
  addOld(id: string, receivedAt?: Timestamp): Promise<StoredEvent>;
  archivedIds(): Promise<EventId[]>;
  activeOldIds(): Promise<EventId[]>;
}

export async function scenario(
  factory: () => Promise<ActiveStore>,
  options: {
    old?: number;
    overflowIndex?: number;
    maxRows?: number;
    /** An external ArchiveStore (for example the real engine) instead of the in-memory one. */
    archive?: ArchiveStore;
  } = {},
): Promise<Scenario> {
  const store = await factory();
  const clock = new FakeClock(NOW);
  const blobs = new MemoryBlobStore();
  const archive = options.archive ?? new MemoryArchiveStore();
  const sent: Scenario["sent"] = [];
  const queue: QueueProducer = {
    send: async (topic, messages) => {
      sent.push({ topic, messages });
    },
  };
  await store.projects.putOrg({
    id: "org" as OrgId,
    slug: "org",
    name: "org",
  });
  const project: Project = {
    id: projectId,
    orgId: "org" as OrgId,
    slug: "p",
    name: "p",
    retentionDays: 1,
  };
  await store.projects.put(project);
  const count = options.old ?? 5;
  const old = Array.from({ length: count }, (_, i) =>
    eventAt(`old${i}`, stamp(BASE + i * 60_000)),
  );
  const recent = [
    eventAt("recent0", "2024-02-29T12:00:00.000Z" as Timestamp),
    eventAt("recent1", NOW as Timestamp),
  ];
  const overflowIndex = options.overflowIndex ?? 2;
  const overflow = old[overflowIndex];
  if (overflow) {
    const key = `payloads/${projectId}/${overflow.eventId}`;
    await blobs.put(key, new TextEncoder().encode('{"big":"payload"}'));
    old[overflowIndex] = { ...overflow, payload: {}, payloadBlobKey: key };
  }
  for (const event of [...old, ...recent]) await seed(store, event);
  let owners = 0;
  const self: Scenario = {
    store,
    blobs,
    archive,
    clock,
    sent,
    fixture: { old, recent },
    worker(o = {}) {
      const faults = o.faults;
      const workerBlobs = faults ? faultyBlobStore(blobs, faults) : blobs;
      return new ArchiveWorker({
        store: faults ? faultyActiveStore(store, faults) : store,
        blobs: workerBlobs,
        archive:
          o.archive ?? (faults ? faultyArchiveStore(archive, faults) : archive),
        queue,
        logger: { info() {}, warn() {}, error() {} },
        clock,
        invocationTimeoutMs: TIMEOUT_MS,
        batchLimits: {
          maxRows: o.maxRows ?? options.maxRows ?? 2,
          maxBytes: 1 << 26,
        },
        deleteChunk: 1,
        newOwner: () => o.owner ?? `w${++owners}`,
      });
    },
    async addOld(id, receivedAt = stamp(BASE - 3_600_000)) {
      const event = eventAt(id, receivedAt);
      await seed(store, event);
      return event;
    },
    async archivedIds() {
      const ids: EventId[] = [];
      let after: { receivedAt: Timestamp; eventId: EventId } | undefined;
      for (;;) {
        const page = await archive.query({
          projectId,
          order: "asc",
          limit: 3,
          after,
        });
        ids.push(...page.items.map((e) => e.eventId));
        const last = page.items.at(-1);
        if (!page.hasMore || !last) return ids;
        after = { receivedAt: last.receivedAt, eventId: last.eventId };
      }
    },
    async activeOldIds() {
      const cutoff = stamp(Date.parse(NOW) - 86_400_000);
      const ids: EventId[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await store.events.scanOlderThan(projectId, cutoff, {
          cursor,
          limit: 100,
        });
        ids.push(...page.items.map((e) => e.eventId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return ids;
    },
  };
  return self;
}

/** Nothing lost, nothing archived twice, nothing left below the cutoff, recent events untouched. */
export async function expectArchivedExactlyOnce(s: Scenario, ids: EventId[]) {
  const archived = await s.archivedIds();
  expect([...archived].sort()).toEqual([...ids].sort());
  expect(new Set(archived).size).toBe(archived.length);
  expect(await s.activeOldIds()).toEqual([]);
  for (const recent of s.fixture.recent)
    expect(await s.store.events.get(projectId, recent.eventId)).not.toBeNull();
  const state = await s.store.meta.getArchiveState(projectId);
  expect(state?.batch).toBeUndefined();
  expect(state?.lease).toBeUndefined();
}

/** Run fresh workers (the previous lease expired) until one finishes; faults are disarmed. */
export async function recover(s: Scenario, faults?: FaultInjector) {
  for (let attempt = 0; attempt < 12; attempt++) {
    s.clock.advance(2 * TIMEOUT_MS + 1);
    try {
      const result = await s.worker({ faults }).run(projectId);
      if (result.status === "done") return;
    } catch (error) {
      if (!(error instanceof InjectedFault)) throw error;
    }
  }
  throw new Error("Archival did not converge");
}

/** An ArchiveStore delegating to `inner`, with `append` replaced. */
function withAppend(
  inner: ArchiveStore,
  append: ArchiveStore["append"],
): ArchiveStore {
  return {
    capabilities: inner.capabilities,
    append,
    hasBatch: (...a: Parameters<ArchiveStore["hasBatch"]>) =>
      inner.hasBatch(...a),
    batchEventIds: (...a: Parameters<ArchiveStore["batchEventIds"]>) =>
      inner.batchEventIds(...a),
    query: (...a: Parameters<ArchiveStore["query"]>) => inner.query(...a),
    getEvent: (...a: Parameters<ArchiveStore["getEvent"]>) =>
      inner.getEvent(...a),
    deleteWhere: (...a: Parameters<ArchiveStore["deleteWhere"]>) =>
      inner.deleteWhere(...a),
    hardErase: (...a: Parameters<ArchiveStore["hardErase"]>) =>
      inner.hardErase(...a),
    expireSnapshots: (...a: Parameters<ArchiveStore["expireSnapshots"]>) =>
      inner.expireSnapshots(...a),
    deleteOlderThan: (...a: Parameters<ArchiveStore["deleteOlderThan"]>) =>
      inner.deleteOlderThan(...a),
    deleteProject: (...a: Parameters<ArchiveStore["deleteProject"]>) =>
      inner.deleteProject(...a),
  };
}

class GatedInjector extends FaultInjector {
  private arrived!: () => void;
  readonly entered = new Promise<void>((resolve) => {
    this.arrived = resolve;
  });
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  constructor(
    private readonly gatedOp: string,
    private readonly gatedNth: number,
  ) {
    super();
  }
  release() {
    this.open();
  }
  override async run<T>(op: string, effect: () => Promise<T>): Promise<T> {
    if (op === this.gatedOp && this.count(op) + 1 === this.gatedNth) {
      this.arrived();
      await this.gate;
    }
    return super.run(op, effect);
  }
}

/** The archival crash-safety suite, parameterized by the active store under test. */
export function archivalSuite(factory: () => Promise<ActiveStore>) {
  describe("archival worker (M4b)", () => {
    it("archives everything below the cutoff, re-inlines and deletes overflow payloads", async () => {
      const s = await scenario(factory);
      const result = await s.worker().run(projectId);
      expect(result).toMatchObject({ status: "done", batches: 3, rows: 5 });
      expect(result.lagMs).toBeGreaterThan(0);
      await expectArchivedExactlyOnce(
        s,
        s.fixture.old.map((e) => e.eventId),
      );
      const overflowed = await s.archive.getEvent(projectId, "old2" as EventId);
      expect(overflowed?.payload).toEqual({ big: "payload" });
      expect(overflowed?.payloadBlobKey).toBeUndefined();
      expect(await s.blobs.head(`payloads/${projectId}/old2`)).toBeNull();
      expect((await s.blobs.list("archive-overflow/")).items).toEqual([]);
      const state = await s.store.meta.getArchiveState(projectId);
      expect(state?.seq).toBe(3);
      expect(state?.archivedThrough).toBe(s.fixture.old[4]?.receivedAt);
    });

    it("is a no-op on a second run and reports no lag", async () => {
      const s = await scenario(factory);
      await s.worker().run(projectId);
      const again = await s.worker().run(projectId);
      expect(again).toMatchObject({ status: "done", batches: 0, lagMs: 0 });
    });

    it("skips an unknown project", async () => {
      const s = await scenario(factory);
      expect((await s.worker().run("999" as ProjectId)).status).toBe(
        "missing-project",
      );
    });

    it("archives a late event inserted below the watermark on the next run", async () => {
      const s = await scenario(factory);
      await s.worker().run(projectId);
      const before = await s.store.meta.getArchiveState(projectId);
      const late = await s.addOld("late");
      expect(late.receivedAt < (before?.archivedThrough ?? "")).toBe(true);
      expect(await s.store.events.get(projectId, late.eventId)).not.toBeNull();
      await s.worker().run(projectId);
      await expectArchivedExactlyOnce(s, [
        ...s.fixture.old.map((e) => e.eventId),
        late.eventId,
      ]);
      const after = await s.store.meta.getArchiveState(projectId);
      expect(after?.archivedThrough).toBe(before?.archivedThrough);
      expect(after?.seq).toBe((before?.seq ?? 0) + 1);
    });

    it("leaves a live lease alone and takes over an expired one", async () => {
      const s = await scenario(factory);
      const faults = new FaultInjector().arm({
        op: "events.deleteBatch",
        nth: 1,
        when: "after",
      });
      await expect(s.worker({ faults }).run(projectId)).rejects.toBeInstanceOf(
        InjectedFault,
      );
      expect((await s.worker().run(projectId)).status).toBe("busy");
      s.clock.advance(2 * TIMEOUT_MS - 1);
      expect((await s.worker().run(projectId)).status).toBe("busy");
      s.clock.advance(2);
      expect((await s.worker().run(projectId)).status).toBe("done");
      await expectArchivedExactlyOnce(
        s,
        s.fixture.old.map((e) => e.eventId),
      );
    });

    it("stops at 60% of the time budget and sends a keyed continuation", async () => {
      const s = await scenario(factory);
      const slow = withAppend(s.archive, async (batch) => {
        s.clock.advance(0.61 * TIMEOUT_MS);
        return s.archive.append(batch);
      });
      const first = await s.worker({ archive: slow }).run(projectId);
      expect(first).toMatchObject({ status: "continued", batches: 1, rows: 2 });
      expect(s.sent).toEqual([
        {
          topic: ARCHIVE_PROJECT_TOPIC,
          messages: [
            {
              key: `archive-continue/${projectId}/1`,
              body: { projectId, continuation: true },
            },
          ],
        },
      ]);
      // the lease was released before the continuation was sent
      const state = await s.store.meta.getArchiveState(projectId);
      expect(state?.lease).toBeUndefined();
      expect(state?.batch).toBeUndefined();
      expect((await s.worker().run(projectId)).status).toBe("done");
      await expectArchivedExactlyOnce(
        s,
        s.fixture.old.map((e) => e.eventId),
      );
    });

    it("handles an archive.project delivery and rejects malformed ones", async () => {
      const s = await scenario(factory);
      const results = await s.worker().handle([
        {
          id: "1",
          topic: ARCHIVE_PROJECT_TOPIC,
          message: { key: "k", body: { projectId } },
          attempt: 1,
        },
        {
          id: "2",
          topic: ARCHIVE_PROJECT_TOPIC,
          message: { key: "k", body: { projectId: "../x" } },
          attempt: 1,
        },
      ]);
      expect(results).toEqual([
        { deliveryId: "1", action: "ack" },
        { deliveryId: "2", action: "ack" },
      ]);
      await expectArchivedExactlyOnce(
        s,
        s.fixture.old.map((e) => e.eventId),
      );
    });

    it("retries a delivery whose run failed", async () => {
      const s = await scenario(factory);
      const faults = new FaultInjector().arm({
        op: "archive.append",
        nth: 1,
        when: "before",
      });
      const results = await s.worker({ faults }).handle([
        {
          id: "1",
          topic: ARCHIVE_PROJECT_TOPIC,
          message: { key: "k", body: { projectId } },
          attempt: 1,
        },
      ]);
      expect(results).toEqual([{ deliveryId: "1", action: "retry" }]);
    });

    it("stops a stale holder at its next CAS after the new owner finished the batch", async () => {
      const s = await scenario(factory);
      // A stalls in DELETE of batch 0 (after MARK); B takes over once A's lease expired.
      const gated = new GatedInjector("events.deleteBatch", 1);
      const a = s.worker({ faults: gated, owner: "A" }).run(projectId);
      const settled = a.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await gated.entered;
      s.clock.advance(2 * TIMEOUT_MS + 1);
      const b = await s.worker({ owner: "B" }).run(projectId);
      expect(b.status).toBe("done");
      const before = await s.store.meta.getArchiveState(projectId);
      gated.release();
      const outcome = await settled;
      expect("value" in outcome && outcome.value.status).toBe("lost");
      // the stale worker wrote nothing after losing
      expect(await s.store.meta.getArchiveState(projectId)).toEqual(before);
      await expectArchivedExactlyOnce(
        s,
        s.fixture.old.map((e) => e.eventId),
      );
    });

    it("fences a stale holder at the committing CAS, so it cannot append", async () => {
      const s = await scenario(factory);
      // A scanned its rows but stalls before the CAS that records `committing`.
      const gated = new GatedInjector("meta.compareAndSetArchiveState", 2);
      const appended: string[] = [];
      const recording = withAppend(s.archive, async (batch) => {
        appended.push(batch.batchId);
        return s.archive.append(batch);
      });
      const a = s
        .worker({ faults: gated, owner: "A", archive: recording })
        .run(projectId);
      const settled = a.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await gated.entered;
      s.clock.advance(2 * TIMEOUT_MS + 1);
      expect((await s.worker({ owner: "B" }).run(projectId)).status).toBe(
        "done",
      );
      gated.release();
      const outcome = await settled;
      expect("value" in outcome && outcome.value.status).toBe("lost");
      expect(appended).toEqual([]);
      await expectArchivedExactlyOnce(
        s,
        s.fixture.old.map((e) => e.eventId),
      );
    });

    it("catches an append racing a takeover with the same batch id", async () => {
      const s = await scenario(factory);
      // A recorded `committing` and stalls right before its append; B abandons and re-commits the
      // batch under the same id; A's late append is then a no-op and its MARK CAS fails.
      const gated = new GatedInjector("archive.append", 1);
      const a = s.worker({ faults: gated, owner: "A" }).run(projectId);
      const settled = a.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await gated.entered;
      s.clock.advance(2 * TIMEOUT_MS + 1);
      expect((await s.worker({ owner: "B" }).run(projectId)).status).toBe(
        "done",
      );
      gated.release();
      const outcome = await settled;
      expect("value" in outcome && outcome.value.status).toBe("lost");
      await expectArchivedExactlyOnce(
        s,
        s.fixture.old.map((e) => e.eventId),
      );
    });

    it("survives a crash before and after every operation of the six-step machine", async () => {
      const dry = new FaultInjector();
      const probe = await scenario(factory);
      await probe.worker({ faults: dry }).run(projectId);
      const calls = dry.calls();
      const cells: { op: string; nth: number; when: "before" | "after" }[] = [];
      for (const [op, count] of Object.entries(calls))
        for (let nth = 1; nth <= count; nth++)
          for (const when of ["before", "after"] as const)
            cells.push({ op, nth, when });
      // each of the six steps and each CAS is among the cells
      for (const op of [
        "events.scanOlderThan",
        "blob.put",
        "meta.compareAndSetArchiveState",
        "archive.append",
        "archive.batchEventIds",
        "events.deleteBatch",
        "blob.delete",
      ])
        expect(calls[op]).toBeGreaterThan(0);
      expect(calls["meta.compareAndSetArchiveState"]).toBe(11);
      for (const cell of cells) {
        const label = `${cell.op}#${cell.nth} ${cell.when}`;
        try {
          const s = await scenario(factory);
          const faults = new FaultInjector().arm(cell);
          await s
            .worker({ faults })
            .run(projectId)
            .catch((error: unknown) => {
              if (!(error instanceof InjectedFault)) throw error;
            });
          expect(faults.fired).toHaveLength(1);
          await recover(s, faults);
          await expectArchivedExactlyOnce(
            s,
            s.fixture.old.map((e) => e.eventId),
          );
        } catch (error) {
          throw new Error(`fault cell ${label}: ${String(error)}`, {
            cause: error,
          });
        }
      }
    }, 120_000);

    it("probes hasBatch when it resumes a committing batch, crashing around the probe", async () => {
      for (const when of ["before", "after"] as const) {
        const s = await scenario(factory);
        // the append took effect but the worker died before MARK: state is `committing`
        const first = new FaultInjector().arm({
          op: "archive.append",
          nth: 1,
          when: "after",
        });
        await expect(
          s.worker({ faults: first }).run(projectId),
        ).rejects.toBeInstanceOf(InjectedFault);
        expect(
          (await s.store.meta.getArchiveState(projectId))?.batch?.state,
        ).toBe("committing");
        const second = new FaultInjector().arm({
          op: "archive.hasBatch",
          nth: 1,
          when,
        });
        s.clock.advance(2 * TIMEOUT_MS + 1);
        await expect(
          s.worker({ faults: second }).run(projectId),
        ).rejects.toBeInstanceOf(InjectedFault);
        expect(second.count("archive.hasBatch")).toBe(1);
        const third = new FaultInjector();
        await recover(s, third);
        // the probe found the batch, so batch 0 was appended exactly once
        expect(third.count("archive.append")).toBe(2);
        await expectArchivedExactlyOnce(
          s,
          s.fixture.old.map((e) => e.eventId),
        );
      }
    });

    it("abandons a committing batch the archive never saw and rebuilds it under the same id", async () => {
      const s = await scenario(factory);
      const first = new FaultInjector().arm({
        op: "archive.append",
        nth: 1,
        when: "before",
      });
      await expect(
        s.worker({ faults: first }).run(projectId),
      ).rejects.toBeInstanceOf(InjectedFault);
      const crashed = await s.store.meta.getArchiveState(projectId);
      expect(crashed?.batch).toMatchObject({ id: "1/0", state: "committing" });
      // a late event arrives before the retry: the rebuilt batch may differ from the abandoned one
      const late = await s.addOld("late", stamp(BASE - 1000));
      const probe = new FaultInjector();
      await recover(s, probe);
      expect(probe.count("archive.hasBatch")).toBe(1);
      await expectArchivedExactlyOnce(s, [
        late.eventId,
        ...s.fixture.old.map((e) => e.eventId),
      ]);
    });
  });
}

/** Archive-side housekeeping (M4h) over the archival scenario; `factory` supplies the active store. */
export function housekeepingSuite(factory: () => Promise<ActiveStore>) {
  const FIRED = NOW as Timestamp;
  function logs() {
    const entries: { level: string; message: string; fields?: unknown }[] = [];
    const log =
      (level: string) => (message: string, fields?: Record<string, unknown>) =>
        entries.push({ level, message, fields });
    return {
      entries,
      logger: { info: log("info"), warn: log("warn"), error: log("error") },
    };
  }
  const options = (
    s: Scenario,
    extra: Partial<Parameters<typeof runArchiveHousekeeping>[0]> = {},
  ) => {
    const log = logs();
    return {
      log,
      options: {
        store: s.store,
        blobs: s.blobs,
        archive: s.archive,
        worker: s.worker({ owner: "housekeeper" }),
        logger: log.logger,
        ...extra,
      },
    };
  };
  const allIds = (s: Scenario) => s.archivedIds();

  describe("archive housekeeping (M4h)", () => {
    it("hard retention deletes archive rows past archiveRetentionDays and keeps younger ones", async () => {
      const s = await scenario(factory);
      await s.worker().run(projectId);
      const keep = options(s, { archiveRetentionDays: 90 });
      expect(await runArchiveHousekeeping(keep.options, FIRED)).toMatchObject({
        retentionDeleted: 0,
      });
      expect(await allIds(s)).toHaveLength(5);
      // the old rows are 60 days old at NOW
      const drop = options(s, { archiveRetentionDays: 30 });
      expect(await runArchiveHousekeeping(drop.options, FIRED)).toMatchObject({
        retentionDeleted: 5,
        busy: 0,
      });
      expect(await allIds(s)).toEqual([]);
      const again = await runArchiveHousekeeping(drop.options, FIRED);
      expect(again.retentionDeleted).toBe(0);
      const state = await s.store.meta.getArchiveState(projectId);
      expect(state?.lease).toBeUndefined();
      expect(state?.batch).toBeUndefined();
    });

    it("skips hard retention for a project whose retentionDays is not below archiveRetentionDays", async () => {
      const s = await scenario(factory);
      await s.worker().run(projectId);
      const run = options(s, { archiveRetentionDays: 1 });
      expect(await runArchiveHousekeeping(run.options, FIRED)).toMatchObject({
        retentionDeleted: 0,
      });
      expect(run.log.entries.some((e) => e.level === "warn")).toBe(true);
      expect(await allIds(s)).toHaveLength(5);
    });

    it("rejects a non-positive archiveRetentionDays", async () => {
      const s = await scenario(factory);
      await expect(
        runArchiveHousekeeping(
          options(s, { archiveRetentionDays: 0 }).options,
          FIRED,
        ),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it("leaves a project alone while another holder has a live lease", async () => {
      const s = await scenario(factory);
      await s.worker().run(projectId);
      const holder = s.worker({ owner: "other" });
      const lease = await holder.acquire(projectId);
      expect(lease).not.toBeNull();
      const run = options(s, { archiveRetentionDays: 30 });
      expect(await runArchiveHousekeeping(run.options, FIRED)).toMatchObject({
        retentionDeleted: 0,
        busy: 1,
      });
      expect(await allIds(s)).toHaveLength(5);
      if (lease) await holder.release(lease);
      expect(await runArchiveHousekeeping(run.options, FIRED)).toMatchObject({
        retentionDeleted: 5,
        busy: 0,
      });
    });

    it("finishes a batch a crashed worker left in flight before deleting, never racing it", async () => {
      const s = await scenario(factory);
      const faults = new FaultInjector().arm({
        op: "archive.append",
        nth: 1,
        when: "after",
      });
      await expect(s.worker({ faults }).run(projectId)).rejects.toBeInstanceOf(
        InjectedFault,
      );
      expect(
        (await s.store.meta.getArchiveState(projectId))?.batch,
      ).toBeDefined();
      // while the dead worker's lease is live housekeeping must not touch the project
      const run = options(s, { archiveRetentionDays: 30 });
      expect(await runArchiveHousekeeping(run.options, FIRED)).toMatchObject({
        busy: 1,
        retentionDeleted: 0,
      });
      expect(await allIds(s)).toHaveLength(2);
      s.clock.advance(2 * TIMEOUT_MS + 1);
      const result = await runArchiveHousekeeping(run.options, FIRED);
      // the batch was driven to completion (rows deleted from the active store) and then expired
      expect(result.retentionDeleted).toBe(2);
      const state = await s.store.meta.getArchiveState(projectId);
      expect(state?.batch).toBeUndefined();
      expect(state?.lease).toBeUndefined();
      expect(await allIds(s)).toEqual([]);
      expect((await s.activeOldIds()).length).toBe(3);
      // the remaining old rows archive later and are expired by the next tick
      await recover(s);
      await runArchiveHousekeeping(run.options, FIRED);
      expect(await allIds(s)).toEqual([]);
      expect(await s.activeOldIds()).toEqual([]);
    });

    it("sweeps orphan overflow manifests under the lease, not the payloads, and not a busy project's", async () => {
      const s = await scenario(factory);
      const enc = (id: string) => encodeURIComponent(id);
      const orphan = `archive-overflow/${enc(`${projectId}/7`)}-w9-0.json`;
      const busyOrphan = `archive-overflow/${enc("2/1")}-w9-0.json`;
      const unknown = `archive-overflow/${enc("404/1")}-w9-0.json`;
      const body = new TextEncoder().encode(`["payloads/${projectId}/old2"]`);
      for (const key of [orphan, busyOrphan, unknown, "archive-overflow/junk"])
        await s.blobs.put(key, body);
      await s.store.projects.put({
        id: "2" as ProjectId,
        orgId: "org" as OrgId,
        slug: "p2",
        name: "p2",
        retentionDays: 1,
      });
      const holder = s.worker({ owner: "other" });
      const lease = await holder.acquire("2" as ProjectId);
      const run = options(s);
      const result = await runArchiveHousekeeping(run.options, FIRED);
      expect(result.manifestsDeleted).toBe(2);
      expect(result.busy).toBe(1);
      expect(await s.blobs.head(orphan)).toBeNull();
      expect(await s.blobs.head(unknown)).toBeNull();
      expect(await s.blobs.head(busyOrphan)).not.toBeNull();
      expect(await s.blobs.head("archive-overflow/junk")).not.toBeNull();
      // the payload the orphan manifest listed is still referenced by its active row
      expect(await s.blobs.head(`payloads/${projectId}/old2`)).not.toBeNull();
      if (lease) await holder.release(lease);
      expect(
        (await runArchiveHousekeeping(run.options, FIRED)).manifestsDeleted,
      ).toBe(1);
    });

    it("raises the lag alarm for an un-archived backlog and not after archival", async () => {
      const s = await scenario(factory);
      const lagging = options(s, { lagAlarmMs: 60_000 });
      expect(
        await runArchiveHousekeeping(lagging.options, FIRED),
      ).toMatchObject({
        lagAlarms: 1,
      });
      const alarm = lagging.log.entries.find((e) => e.level === "warn");
      expect(alarm?.message).toBe("Archival lag alarm");
      expect(alarm?.fields).toMatchObject({ alarm: "archival-lag", projectId });
      await s.worker().run(projectId);
      const healthy = options(s, { lagAlarmMs: 60_000 });
      expect(
        await runArchiveHousekeeping(healthy.options, FIRED),
      ).toMatchObject({
        lagAlarms: 0,
      });
    });

    it("expires snapshots only when configured and tolerates engines without support", async () => {
      const s = await scenario(factory);
      const calls: Timestamp[] = [];
      const archive: ArchiveStore = {
        ...s.archive,
        capabilities: s.archive.capabilities,
        expireSnapshots: async (olderThan) => {
          calls.push(olderThan);
        },
      } as ArchiveStore;
      const unset = options(s, { archive });
      expect(
        (await runArchiveHousekeeping(unset.options, FIRED)).snapshotsExpired,
      ).toBe(false);
      expect(calls).toEqual([]);
      const set = options(s, { archive, snapshotExpiryDays: 7 });
      expect(
        (await runArchiveHousekeeping(set.options, FIRED)).snapshotsExpired,
      ).toBe(true);
      expect(calls).toEqual(["2024-02-23T00:00:00.000Z"]);
      const unsupported: ArchiveStore = {
        ...archive,
        expireSnapshots: async () => {
          throw new UnsupportedQueryError("no");
        },
      } as ArchiveStore;
      const tolerant = options(s, {
        archive: unsupported,
        snapshotExpiryDays: 7,
      });
      expect(
        (await runArchiveHousekeeping(tolerant.options, FIRED))
          .snapshotsExpired,
      ).toBe(false);
    });

    it("purges a deleted project's archive rows under its lease and refuses while it is busy", async () => {
      const s = await scenario(factory);
      await s.worker().run(projectId);
      const run = options(s);
      const holder = s.worker({ owner: "other" });
      const lease = await holder.acquire(projectId);
      await expect(
        purgeProjectArchive(run.options, projectId),
      ).rejects.toBeInstanceOf(ArchiveBusyError);
      expect(await allIds(s)).toHaveLength(5);
      if (lease) await holder.release(lease);
      expect(await purgeProjectArchive(run.options, projectId)).toEqual({
        rowsDeleted: 5,
      });
      expect(await allIds(s)).toEqual([]);
      expect(await purgeProjectArchive(run.options, projectId)).toEqual({
        rowsDeleted: 0,
      });
    });
  });
}
