import { FakeClock, queueContract } from "@errtraq/testing";
import { expect, it, vi } from "vitest";
import { create } from "./index.js";

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
