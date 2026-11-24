import {
  type ActiveStore,
  bootstrapProject,
  ConsumerService,
  type Delivery,
  type EventId,
  type Message,
  normalizeEvent,
  type ProjectId,
  type ProjectRateLimits,
  projectReader,
  type Queue,
  type RateRejectionConfig,
  RecordHandler,
  readDropped,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it, vi } from "vitest";
import { MemoryBlobStore, MemoryKV } from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

const id = (value: number) => value.toString(16).padStart(32, "0") as EventId;
type Mode = "direct" | "grouped";
interface Spec {
  n: number;
  message: string;
}

/**
 * Drive rate rejection through the real consumer (and, in grouped mode, the real record
 * handler) over one active store. Charging is exact under retries and redelivery: a retried or
 * redelivered event is not charged again and reuses its first decision.
 */
async function pipeline(
  createStore: () => Promise<ActiveStore>,
  mode: Mode,
  rate: RateRejectionConfig,
) {
  const store = await createStore();
  const clock = new FakeClock();
  const kv = new MemoryKV(clock);
  const blobs = new MemoryBlobStore();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const ids = new DeterministicIdGen();
  const a = (
    await bootstrapProject({ store, kv, ids, orgSlug: "org", projectSlug: "a" })
  ).project.id;
  const b = (
    await bootstrapProject({ store, kv, ids, orgSlug: "org", projectSlug: "b" })
  ).project.id;
  const records: Message[] = [];
  const state = { failSend: 0 };
  const queue = {
    capabilities: { maxBytes: 1 << 20 },
    producer: {
      send: async (topic: string, messages: Message[]) => {
        if (state.failSend > 0) {
          state.failSend--;
          throw new Error("record publication failed");
        }
        if (topic === "record") records.push(...structuredClone(messages));
      },
    },
  } as unknown as Queue;
  // Mirror the platforms: the grouped consumer is granted project reads only (and only when a
  // per-issue limit needs them), never the store; direct mode keeps the store.
  const consumer = new ConsumerService({
    ...(mode === "grouped"
      ? { projects: rate.issueRateLimit ? projectReader(store) : undefined }
      : { store }),
    blobs,
    kv,
    logger,
    recordMode: mode,
    queue,
    rateRejection: rate,
  });
  const handler = new RecordHandler({
    store,
    blobs,
    kv,
    logger,
    rateRejection: rate,
  });
  const payloads = new Map<string, Uint8Array>();
  let seq = 0;
  const claim = (projectId: ProjectId, events: Spec[]): Delivery => {
    const blobKey = `envelopes/${projectId}/${++seq}`;
    const text = `{}\n${events.map(({ n, message }) => `{"type":"event"}\n${JSON.stringify({ event_id: id(n), message })}\n`).join("")}`;
    payloads.set(blobKey, new TextEncoder().encode(text));
    return {
      id: `d${seq}`,
      topic: "ingest",
      attempt: 1,
      message: {
        key: id(events[0]?.n ?? 0),
        body: { projectId, blobKey, receivedAt: clock.now() },
      },
    };
  };
  /** Run deliveries through the consumer, then the record handler in grouped mode. */
  const run = async (deliveries: Delivery[]) => {
    for (const delivery of deliveries) {
      const { blobKey } = delivery.message.body as { blobKey: string };
      const bytes = payloads.get(blobKey);
      if (bytes && !(await blobs.head(blobKey)))
        await blobs.put(blobKey, bytes, { size: bytes.length });
    }
    const ingest = (await consumer.handle(deliveries)).map((r) => r.action);
    const queued = records.splice(0);
    const record = (
      await handler.handle(
        queued.map((message) => ({
          id: `r${++seq}`,
          topic: "record",
          attempt: 1,
          message,
        })),
      )
    ).map((r) => r.action);
    return { ingest, record: mode === "grouped" ? record : [] };
  };
  const issueId = async (projectId: ProjectId, message: string) =>
    (await normalizeEvent(projectId, id(0), clock.now(), { message })).event
      .issueId;
  const issue = async (projectId: ProjectId, message: string) =>
    store.issues.get(projectId, await issueId(projectId, message));
  const has = async (projectId: ProjectId, n: number) =>
    (await store.events.get(projectId, id(n))) !== null;
  const dropped = async (
    projectId: ProjectId,
    message: string,
    at = clock.now(),
  ) =>
    (
      await readDropped(
        kv,
        rate,
        projectId,
        await issueId(projectId, message),
        at,
      )
    )?.count;
  /** Persist per-project overrides the way the operator CLI does. */
  const setLimits = async (
    projectId: ProjectId,
    rateLimits: ProjectRateLimits,
  ) => {
    const project = await store.projects.get(projectId);
    if (!project) throw new Error("Missing project");
    await store.projects.put({ ...project, rateLimits });
  };
  /** Current value of the per-issue counter for the window containing the clock (windowSec 60). */
  const issueCounter = async (projectId: ProjectId, message: string) =>
    Number(
      (await kv.get(
        `rate:issue:${projectId}:${await issueId(projectId, message)}:${Math.floor(Date.parse(clock.now()) / 60_000)}`,
      )) ?? 0,
    );
  /** Total increment amount applied to counters whose key starts with the prefix. */
  const charged = (spy: { mock: { calls: unknown[][] } }, prefix: string) =>
    spy.mock.calls
      .filter(([key]) => String(key).startsWith(prefix))
      .reduce((sum, call) => sum + Number(call[1]), 0);
  const failDownstreamOnce = () => {
    if (mode === "grouped") state.failSend = 1;
    else
      vi.spyOn(store, "recordEvent").mockRejectedValueOnce(
        new Error("temporary"),
      );
  };
  return {
    store,
    clock,
    kv,
    blobs,
    logger,
    a,
    b,
    claim,
    run,
    issueId,
    issue,
    has,
    dropped,
    charged,
    setLimits,
    issueCounter,
    failDownstreamOnce,
  };
}

/** Shared by the in-memory store and the SQLite store; no emulator or network is needed. */
export function rateRejectionPipelineSuite(
  name: string,
  createStore: () => Promise<ActiveStore>,
): void {
  describe.each(["direct", "grouped"] as const)(
    `${name} rate rejection pipeline (%s)`,
    (mode) => {
      const setup = (rate: RateRejectionConfig) =>
        pipeline(createStore, mode, rate);

      it("charges a retried delivery once after a downstream failure and keeps its decisions", async () => {
        const c = await setup({ issueRateLimit: { events: 1, windowSec: 60 } });
        const delivery = c.claim(c.a, [
          { n: 1, message: "same" },
          { n: 2, message: "same" },
        ]);
        c.failDownstreamOnce();
        const increment = vi.spyOn(c.kv, "increment");
        expect((await c.run([delivery])).ingest).toEqual(["retry"]);
        expect(c.charged(increment, "rate:issue:")).toBe(2);
        expect(await c.dropped(c.a, "same")).toBe(1);
        expect(await c.blobs.head(`envelopes/${c.a}/1`)).not.toBeNull();
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect(c.charged(increment, "rate:issue:")).toBe(2);
        expect(await c.issueCounter(c.a, "same")).toBe(2);
        expect(await c.has(c.a, 1)).toBe(true);
        expect(await c.has(c.a, 2)).toBe(false);
        // The rejected event is not counted as dropped again on the retry.
        expect(await c.dropped(c.a, "same")).toBe(1);
      });
      it("does not charge a failed counter under retry, and the redelivery is charged once", async () => {
        const c = await setup({
          issueRateLimit: { events: 2, windowSec: 60 },
          onKvFailure: "retry",
        });
        const delivery = c.claim(c.a, [
          { n: 1, message: "same" },
          { n: 2, message: "same" },
        ]);
        const original = c.kv.increment.bind(c.kv);
        let failed = false;
        vi.spyOn(c.kv, "increment").mockImplementation(async (key, by, o) => {
          if (key.startsWith("rate:issue:") && !failed) {
            failed = true;
            throw new Error("kv down");
          }
          return original(key, by, o);
        });
        expect((await c.run([delivery])).ingest).toEqual(["retry"]);
        expect(await c.has(c.a, 1)).toBe(false);
        // The event markers were released, so the redelivery charges instead of skipping.
        expect(await c.issueCounter(c.a, "same")).toBe(0);
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect(await c.has(c.a, 1)).toBe(true);
        expect(await c.has(c.a, 2)).toBe(true);
        expect(await c.issueCounter(c.a, "same")).toBe(2);
        expect(await c.dropped(c.a, "same")).toBe(0);
      });
      it("fails open under allow, and a KV failure plus a downstream failure still charges each event once", async () => {
        const c = await setup({
          issueRateLimit: { events: 2, windowSec: 60 },
          onKvFailure: "allow",
        });
        const delivery = c.claim(c.a, [
          { n: 1, message: "same" },
          { n: 2, message: "same" },
        ]);
        const original = c.kv.increment.bind(c.kv);
        // The first marker fails: that event is admitted uncharged on this attempt.
        vi.spyOn(c.kv, "increment")
          .mockRejectedValueOnce(new Error("kv down"))
          .mockImplementation(original);
        c.failDownstreamOnce();
        expect((await c.run([delivery])).ingest).toEqual(["retry"]);
        expect(await c.issueCounter(c.a, "same")).toBe(1);
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect(await c.has(c.a, 1)).toBe(true);
        expect(await c.has(c.a, 2)).toBe(true);
        expect(await c.issueCounter(c.a, "same")).toBe(2);
        expect(await c.dropped(c.a, "same")).toBe(0);
      });
      it("admits a retried event uncharged when its first attempt stored no outcome", async () => {
        const c = await setup({ issueRateLimit: { events: 1, windowSec: 60 } });
        const delivery = c.claim(c.a, [
          { n: 1, message: "same" },
          { n: 2, message: "same" },
        ]);
        const put = c.kv.put.bind(c.kv);
        // A crash between the counter and the outcome of the second (over-limit) event.
        vi.spyOn(c.kv, "put").mockImplementation(async (key, value, o) => {
          if (key.startsWith("rate:outcome:") && key.includes(id(2)))
            throw new Error("crash");
          return put(key, value, o);
        });
        c.failDownstreamOnce();
        expect((await c.run([delivery])).ingest).toEqual(["retry"]);
        expect(await c.issueCounter(c.a, "same")).toBe(2);
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect(await c.has(c.a, 1)).toBe(true);
        expect(await c.has(c.a, 2)).toBe(true);
        expect(await c.issueCounter(c.a, "same")).toBe(2);
      });
      it("charges one event once when two consumers attempt it concurrently", async () => {
        const c = await setup({ issueRateLimit: { events: 5, windowSec: 60 } });
        const results = await Promise.all([
          c.run([c.claim(c.a, [{ n: 1, message: "same" }])]),
          c.run([c.claim(c.a, [{ n: 1, message: "same" }])]),
        ]);
        expect(results.flatMap((r) => r.ingest)).toEqual(["ack", "ack"]);
        expect(await c.issueCounter(c.a, "same")).toBe(1);
        expect(await c.has(c.a, 1)).toBe(true);
        expect((await c.issue(c.a, "same"))?.count).toBe(1);
        expect(await c.dropped(c.a, "same")).toBe(0);
      });
      it("keeps limits and dropped counts per project, including identical fingerprints", async () => {
        const c = await setup({
          issueRateLimit: { events: 1, windowSec: 60 },
          newIssueCap: { issues: 1, windowSec: 60 },
        });
        const events = (base: number) => [
          { n: base, message: "x" },
          { n: base + 1, message: "x" },
          { n: base + 2, message: "y" },
        ];
        const result = await c.run([
          c.claim(c.a, events(10)),
          c.claim(c.b, events(20)),
        ]);
        expect(result.ingest).toEqual(["ack", "ack"]);
        expect(await c.issueId(c.a, "x")).not.toBe(await c.issueId(c.b, "x"));
        for (const [project, base] of [
          [c.a, 10],
          [c.b, 20],
        ] as const) {
          expect(await c.has(project, base)).toBe(true);
          expect(await c.has(project, base + 1)).toBe(false);
          expect(await c.has(project, base + 2)).toBe(false);
          expect(await c.dropped(project, "x")).toBe(1);
          expect(await c.dropped(project, "y")).toBe(1);
          expect((await c.issue(project, "x"))?.count).toBe(1);
          expect(await c.issue(project, "y")).toBeNull();
        }
        // A project never sees another project's counter, even for the same issue id.
        expect(
          (
            await readDropped(
              c.kv,
              { issueRateLimit: { events: 1, windowSec: 60 } },
              c.b,
              await c.issueId(c.a, "x"),
              c.clock.now(),
            )
          )?.count,
        ).toBe(0);
      });
      it("admits exactly the new-issue cap across many issues in one window, keeps admitted issues flowing and resets next window", async () => {
        const c = await setup({ newIssueCap: { issues: 3, windowSec: 60 } });
        const names = [0, 1, 2, 3, 4, 5].map((i) => `issue-${i}`);
        const first = names.map((message, i) =>
          c.claim(c.a, [
            { n: 100 + i * 2, message },
            { n: 101 + i * 2, message },
          ]),
        );
        expect((await c.run(first)).ingest.every((x) => x === "ack")).toBe(
          true,
        );
        const admitted = async () =>
          (await Promise.all(names.map((m) => c.issue(c.a, m)))).map(
            (item) => item !== null,
          );
        expect(await admitted()).toEqual([
          true,
          true,
          true,
          false,
          false,
          false,
        ]);
        expect((await c.issue(c.a, "issue-0"))?.count).toBe(2);
        expect(await c.dropped(c.a, "issue-3")).toBe(2);
        expect(await c.dropped(c.a, "issue-0")).toBe(0);
        // Admitted issues keep passing and rejected ones stay rejected within the window.
        await c.run([
          c.claim(c.a, [
            { n: 200, message: "issue-0" },
            { n: 201, message: "issue-3" },
            { n: 202, message: "issue-2" },
          ]),
        ]);
        expect(await c.has(c.a, 200)).toBe(true);
        expect(await c.has(c.a, 201)).toBe(false);
        expect(await c.has(c.a, 202)).toBe(true);
        expect(await c.dropped(c.a, "issue-3")).toBe(3);
        const windowOne = c.clock.now();
        c.clock.advance(60_000);
        await c.run(
          [3, 4, 5].map((i) =>
            c.claim(c.a, [{ n: 300 + i, message: `issue-${i}` }]),
          ),
        );
        expect(await admitted()).toEqual([true, true, true, true, true, true]);
        // The earlier window's drop count is unchanged and the new window starts at zero.
        expect(await c.dropped(c.a, "issue-3", windowOne)).toBe(3);
        expect(await c.dropped(c.a, "issue-3")).toBe(0);
      });
      it("limits a regressing resolved issue per issue without counting the regression as a new issue", async () => {
        const c = await setup({
          issueRateLimit: { events: 2, windowSec: 60 },
          newIssueCap: { issues: 2, windowSec: 60 },
        });
        await c.run([c.claim(c.a, [{ n: 1, message: "r" }])]);
        const resolve = async () =>
          c.store.issues.update(c.a, await c.issueId(c.a, "r"), {
            status: "resolved",
            resolvedAt: c.clock.now(),
          });
        await resolve();
        c.clock.advance(1000);
        const increment = vi.spyOn(c.kv, "increment");
        await c.run([c.claim(c.a, [{ n: 2, message: "r" }])]);
        expect(await c.has(c.a, 2)).toBe(true);
        expect((await c.issue(c.a, "r"))?.status).toBe("unresolved");
        expect(c.charged(increment, "rate:new-issues:")).toBe(0);
        await resolve();
        c.clock.advance(1000);
        await c.run([c.claim(c.a, [{ n: 3, message: "r" }])]);
        // The third event in the window exceeds the per-issue limit, so it neither records nor reopens.
        expect(await c.has(c.a, 3)).toBe(false);
        expect((await c.issue(c.a, "r"))?.status).toBe("resolved");
        expect((await c.issue(c.a, "r"))?.count).toBe(2);
        expect(await c.dropped(c.a, "r")).toBe(1);
        // The regression did not consume the cap: the second distinct issue fits, the third does not.
        await c.run([
          c.claim(c.a, [
            { n: 4, message: "s" },
            { n: 5, message: "t" },
          ]),
        ]);
        expect(await c.has(c.a, 4)).toBe(true);
        expect(await c.has(c.a, 5)).toBe(false);
      });
      it("records a redelivered envelope once and does not charge or drop-count the redelivery", async () => {
        const c = await setup({ issueRateLimit: { events: 1, windowSec: 60 } });
        const delivery = c.claim(c.a, [{ n: 1, message: "dup" }]);
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect((await c.issue(c.a, "dup"))?.count).toBe(1);
        expect(await c.has(c.a, 1)).toBe(true);
        // Direct mode skips the stored event before any KV access; grouped mode reuses the
        // stored "admit" decision. Either way the second delivery is not charged.
        expect(await c.issueCounter(c.a, "dup")).toBe(1);
        expect(await c.dropped(c.a, "dup")).toBe(0);
      });
      it("records one event once and charges it once when it is delivered twice in one batch", async () => {
        const c = await setup({ issueRateLimit: { events: 2, windowSec: 60 } });
        const result = await c.run([
          c.claim(c.a, [{ n: 1, message: "dup" }]),
          c.claim(c.a, [{ n: 1, message: "dup" }]),
        ]);
        expect(result.ingest).toEqual(["ack", "ack"]);
        expect((await c.issue(c.a, "dup"))?.count).toBe(1);
        expect(await c.issueCounter(c.a, "dup")).toBe(1);
        expect(await c.dropped(c.a, "dup")).toBe(0);
      });
      it("charges a candidate new issue once across batches and redeliveries", async () => {
        const c = await setup({ newIssueCap: { issues: 1, windowSec: 60 } });
        const first = c.claim(c.a, [
          { n: 1, message: "kept" },
          { n: 2, message: "refused" },
        ]);
        const increment = vi.spyOn(c.kv, "increment");
        expect((await c.run([first])).ingest).toEqual(["ack"]);
        expect(c.charged(increment, "rate:new-issues:")).toBe(2);
        expect(await c.has(c.a, 1)).toBe(true);
        expect(await c.has(c.a, 2)).toBe(false);
        // A later batch, a redelivery, and a new event of the refused issue are not charged again.
        const later = c.claim(c.a, [{ n: 3, message: "refused" }]);
        expect((await c.run([later])).ingest).toEqual(["ack"]);
        expect((await c.run([first])).ingest).toEqual(["ack"]);
        expect(c.charged(increment, "rate:new-issues:")).toBe(2);
        expect(await c.has(c.a, 3)).toBe(false);
        expect(await c.has(c.a, 2)).toBe(false);
        expect((await c.issue(c.a, "kept"))?.count).toBe(1);
        expect(await c.issue(c.a, "refused")).toBeNull();
        // Each refused event is counted as dropped once, however often it is replayed.
        expect(await c.dropped(c.a, "refused")).toBe(2);
        expect((await c.run([later])).ingest).toEqual(["ack"]);
        expect(await c.dropped(c.a, "refused")).toBe(2);
      });
      it("enforces a project's tighter per-issue limit and leaves another project on the stack limit", async () => {
        const c = await setup({ issueRateLimit: { events: 3, windowSec: 60 } });
        await c.setLimits(c.a, { issueEvents: 1 });
        const events = (base: number) =>
          [0, 1, 2].map((i) => ({ n: base + i, message: "x" }));
        const read = vi.spyOn(c.store.projects, "get");
        expect(
          (await c.run([c.claim(c.a, events(10)), c.claim(c.b, events(20))]))
            .ingest,
        ).toEqual(["ack", "ack"]);
        // Each project is read once for the whole delivery batch.
        expect(read).toHaveBeenCalledTimes(2);
        expect(await c.has(c.a, 10)).toBe(true);
        expect(await c.has(c.a, 11)).toBe(false);
        expect(await c.has(c.a, 12)).toBe(false);
        expect(await c.dropped(c.a, "x")).toBe(2);
        for (const n of [20, 21, 22]) expect(await c.has(c.b, n)).toBe(true);
        expect(await c.dropped(c.b, "x")).toBe(0);
        // Retries keep the decisions that the override produced.
        expect((await c.run([c.claim(c.a, events(10))])).ingest).toEqual([
          "ack",
        ]);
        expect(await c.issueCounter(c.a, "x")).toBe(3);
      });
      it("enforces a project's tighter new-issue cap and leaves another project on the stack cap", async () => {
        const c = await setup({ newIssueCap: { issues: 3, windowSec: 60 } });
        await c.setLimits(c.a, { newIssues: 1 });
        const claims = (project: ProjectId, base: number) =>
          ["i0", "i1", "i2"].map((message, i) =>
            c.claim(project, [{ n: base + i, message }]),
          );
        await c.run([...claims(c.a, 10), ...claims(c.b, 20)]);
        expect(
          (
            await Promise.all(["i0", "i1", "i2"].map((m) => c.issue(c.a, m)))
          ).map((item) => item !== null),
        ).toEqual([true, false, false]);
        expect(
          (
            await Promise.all(["i0", "i1", "i2"].map((m) => c.issue(c.b, m)))
          ).map((item) => item !== null),
        ).toEqual([true, true, true]);
        expect(await c.dropped(c.a, "i1")).toBe(1);
        expect(await c.dropped(c.b, "i1")).toBe(0);
      });
      it("never lets an override loosen the stack limit or enable a disabled one", async () => {
        const c = await setup({ issueRateLimit: { events: 1, windowSec: 60 } });
        await c.setLimits(c.a, { issueEvents: 50, newIssues: 1 });
        await c.run([
          c.claim(c.a, [
            { n: 1, message: "x" },
            { n: 2, message: "x" },
            { n: 3, message: "y" },
          ]),
        ]);
        expect(await c.has(c.a, 1)).toBe(true);
        // Clamped to the stack's one event per issue; the disabled cap admits issue y.
        expect(await c.has(c.a, 2)).toBe(false);
        expect(await c.has(c.a, 3)).toBe(true);
      });
      it("does not read projects when rate rejection is disabled", async () => {
        const c = await setup({});
        const get = vi.spyOn(c.store.projects, "get");
        await c.run([c.claim(c.a, [{ n: 1, message: "x" }])]);
        expect(get).not.toHaveBeenCalled();
        expect(await c.has(c.a, 1)).toBe(true);
      });
    },
  );
}
