import { FakeClock, queueContract } from "@errtraq/testing";
import { expect, it, vi } from "vitest";
import { create as createAdapter } from "./index.js";

const create = (
  config: Parameters<typeof createAdapter>[0]["config"] = {} as Parameters<
    typeof createAdapter
  >[0]["config"],
  bindings: Parameters<typeof createAdapter>[0]["bindings"] = {},
) => createAdapter({ config, bindings, dependencies: {}, topics: {} });

const clock = new FakeClock();
queueContract(() => create({}, { clock }), {
  clock,
  advance: (ms) => clock.advance(ms),
});
it("exposes in-flight work and waits for it to finish on abort", async () => {
  const queue = create();
  const controller = new AbortController();
  let finish: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const running = queue.pull.run(async (batch) => {
    await gate;
    return batch.map((d) => ({ deliveryId: d.id, action: "ack" as const }));
  }, controller.signal);
  await queue.producer.send("ingest", [{ key: "k", body: 1 }]);
  await vi.waitFor(() => expect(queue.inFlight).toHaveLength(1));
  expect(queue.inFlight[0]?.topic).toBe("ingest");
  controller.abort();
  finish?.();
  await running;
  expect(queue.inFlight).toEqual([]);
});

it.each(["throw", "missing"])(
  "backs off, eventually drops and logs %s failures",
  async (mode) => {
    const log = vi.fn();
    const queue = create({ maxAttempts: 3 }, { logger: { error: log } });
    const controller = new AbortController();
    let calls = 0;
    const run = queue.pull.run(async () => {
      calls++;
      if (mode === "throw") throw new Error("fail");
      return [];
    }, controller.signal);
    await queue.producer.send("ingest", [{ key: "x", body: null }]);
    try {
      await vi.waitFor(() => expect(log).toHaveBeenCalledOnce(), {
        timeout: 1000,
      });
      expect(calls).toBe(3);
    } finally {
      controller.abort();
      await run;
    }
  },
);

it("allows abort while failures continue", async () => {
  const queue = create({ maxAttempts: 1000 });
  const controller = new AbortController();
  let calls = 0;
  const run = queue.pull.run(async () => {
    calls++;
    throw new Error("fail");
  }, controller.signal);
  await queue.producer.send("ingest", [{ key: "x", body: null }]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();
  await run;
  expect(calls).toBeLessThan(20);
});

it("rejects a whole batch when cloning fails and rejects invalid delays", async () => {
  const q = create();
  await expect(
    q.producer.send("x", [
      { key: "ok", body: 1 },
      { key: "bad", body: () => {} },
    ]),
  ).rejects.toThrow();
  for (const delaySec of [-1, Number.NaN, Number.POSITIVE_INFINITY])
    await expect(
      q.producer.send("x", [{ key: "x", body: 1 }], { delaySec }),
    ).rejects.toThrow();
  const controller = new AbortController();
  const seen: string[] = [];
  const run = q.pull.run(async (batch) => {
    seen.push(...batch.map((d) => d.message.key));
    return batch.map((d) => ({ deliveryId: d.id, action: "ack" as const }));
  }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort();
  await run;
  expect(seen).toEqual([]);
});
it("rejects oversized messages", async () => {
  const q = create();
  await expect(
    q.producer.send("x", [
      { key: "large", body: "x".repeat(q.capabilities.maxBytes) },
    ]),
  ).rejects.toThrow();
});

it("uses the resolved topic map and preserves logical topics on the shared queue", async () => {
  const queue = createAdapter({
    config: {},
    bindings: {},
    dependencies: {},
    topics: {
      ingest: { physical: "shared" },
      "archive.project": { physical: "shared" },
      notifications: { physical: "shared" },
    },
  });
  await expect(
    queue.producer.send("unknown", [{ key: "x", body: {} }]),
  ).rejects.toThrow("Unknown queue topic");
  await queue.producer.send("archive.project", [{ key: "x", body: {} }]);
  const signal = new AbortController();
  await queue.pull.run(async (deliveries) => {
    expect(deliveries[0]?.topic).toBe("archive.project");
    signal.abort();
    return deliveries.map((item) => ({
      deliveryId: item.id,
      action: "ack" as const,
    }));
  }, signal.signal);
});
