import {
  type ActiveStore,
  bootstrapProject,
  ConsumerService,
  type Delivery,
  type EventId,
  type Message,
  normalizeEvent,
  type ProjectId,
  type Queue,
  type RateRejectionConfig,
  RecordHandler,
  readDropped,
} from "@errtraq/core";
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
 * handler) over one active store. Counters are approximate by design: increments are not
 * idempotent, so a retried or redelivered batch is charged again. The tests name that.
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
  const consumer = new ConsumerService({
    store,
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

      it("charges a retried delivery again after a downstream failure, so a retry can be dropped by the limit", async () => {
        const c = await setup({ issueRateLimit: { events: 2, windowSec: 60 } });
        const delivery = c.claim(c.a, [
          { n: 1, message: "same" },
          { n: 2, message: "same" },
        ]);
        c.failDownstreamOnce();
        const increment = vi.spyOn(c.kv, "increment");
        expect((await c.run([delivery])).ingest).toEqual(["retry"]);
        expect(c.charged(increment, "rate:issue:")).toBe(2);
        expect(await c.blobs.head(`envelopes/${c.a}/1`)).not.toBeNull();
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect(c.charged(increment, "rate:issue:")).toBe(4);
        expect(await c.has(c.a, 1)).toBe(false);
        expect(await c.has(c.a, 2)).toBe(false);
        expect(await c.dropped(c.a, "same")).toBe(2);
      });
      it("does not charge a failed KV increment under retry, and the redelivery is charged once", async () => {
        const c = await setup({
          issueRateLimit: { events: 2, windowSec: 60 },
          onKvFailure: "retry",
        });
        const delivery = c.claim(c.a, [
          { n: 1, message: "same" },
          { n: 2, message: "same" },
        ]);
        const original = c.kv.increment.bind(c.kv);
        const increment = vi
          .spyOn(c.kv, "increment")
          .mockRejectedValueOnce(new Error("kv down"))
          .mockImplementation(original);
        expect((await c.run([delivery])).ingest).toEqual(["retry"]);
        expect(await c.has(c.a, 1)).toBe(false);
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect(await c.has(c.a, 1)).toBe(true);
        expect(await c.has(c.a, 2)).toBe(true);
        expect(increment).toHaveBeenCalledTimes(2);
        expect(await c.dropped(c.a, "same")).toBe(0);
      });
      it("fails open under allow, so a KV failure plus a downstream failure charges the redelivery only once", async () => {
        const c = await setup({
          issueRateLimit: { events: 2, windowSec: 60 },
          onKvFailure: "allow",
        });
        const delivery = c.claim(c.a, [
          { n: 1, message: "same" },
          { n: 2, message: "same" },
        ]);
        const original = c.kv.increment.bind(c.kv);
        const increment = vi
          .spyOn(c.kv, "increment")
          .mockRejectedValueOnce(new Error("kv down"))
          .mockImplementation(original);
        c.failDownstreamOnce();
        expect((await c.run([delivery])).ingest).toEqual(["retry"]);
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect(await c.has(c.a, 1)).toBe(true);
        expect(await c.has(c.a, 2)).toBe(true);
        expect(c.charged(increment, "rate:issue:")).toBe(4);
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
      it("records a redelivered envelope once and charges the redelivery again where the consumer cannot see it is known", async () => {
        const c = await setup({ issueRateLimit: { events: 1, windowSec: 60 } });
        const delivery = c.claim(c.a, [{ n: 1, message: "dup" }]);
        const increment = vi.spyOn(c.kv, "increment");
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect((await c.run([delivery])).ingest).toEqual(["ack"]);
        expect((await c.issue(c.a, "dup"))?.count).toBe(1);
        expect(await c.has(c.a, 1)).toBe(true);
        // Direct mode skips an already stored event before charging; grouped mode has no such
        // read, so the redelivery is charged and counted as dropped although it was recorded.
        expect(c.charged(increment, "rate:issue:")).toBe(
          mode === "direct" ? 1 : 2,
        );
        expect(await c.dropped(c.a, "dup")).toBe(mode === "direct" ? 0 : 1);
      });
      it("records one event once when the same event is delivered twice in one batch", async () => {
        const c = await setup({ issueRateLimit: { events: 2, windowSec: 60 } });
        const increment = vi.spyOn(c.kv, "increment");
        const result = await c.run([
          c.claim(c.a, [{ n: 1, message: "dup" }]),
          c.claim(c.a, [{ n: 1, message: "dup" }]),
        ]);
        expect(result.ingest).toEqual(["ack", "ack"]);
        expect((await c.issue(c.a, "dup"))?.count).toBe(1);
        expect(c.charged(increment, "rate:issue:")).toBe(2);
        expect(await c.dropped(c.a, "dup")).toBe(0);
      });
    },
  );
}
