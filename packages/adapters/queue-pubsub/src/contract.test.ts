import type { Delivery, Queue } from "@moriyoshi/errtraq-core";
import { queueContract } from "@moriyoshi/errtraq-testing";
import { describe, expect, it } from "vitest";
import { FakePubsub, PROJECT, verifyToken } from "./fake.testing.js";
import { PubsubQueue } from "./runtime.js";

const topic = (name: string) => `projects/${PROJECT}/topics/${name}`;
const subscription = (name: string) =>
  `projects/${PROJECT}/subscriptions/${name}`;
const fakes = new WeakMap<Queue, FakePubsub>();

export function makeQueue(fake = new FakePubsub()): PubsubQueue {
  const queue = new PubsubQueue({
    projectId: PROJECT,
    region: "us-central1",
    bindings: { SHARED: topic("shared"), RECORD: topic("record") },
    topics: {
      ingest: { physical: "shared", producerBinding: "SHARED" },
      "archive.project": { physical: "shared", producerBinding: "SHARED" },
      contract: { physical: "shared", producerBinding: "SHARED" },
      record: {
        physical: "record",
        producerBinding: "RECORD",
        grouping: "per-key-serial",
      },
    },
    consumers: [
      {
        physical: "shared",
        eventSource: subscription("shared"),
        topics: ["ingest", "archive.project", "contract"],
      },
      {
        physical: "record",
        eventSource: subscription("record"),
        topics: ["record"],
      },
    ],
    accessToken: async () => "access-token",
    verifyPush: verifyToken,
    fetch: fake.fetch,
    sleep: async () => {},
  });
  fakes.set(queue, fake);
  return queue;
}

describe("queue-pubsub on the offline Pub/Sub fake", () => {
  queueContract(async () => makeQueue(), {
    deliverPush: async (queue, handler) => {
      const fake = fakes.get(queue);
      const push = (queue as PubsubQueue).push;
      if (!fake) throw new Error("Missing fake");
      await fake.push(subscription("shared"), (request) =>
        push.handle(request, handler),
      );
    },
  });
  it("keeps per-key order, stopping a key after a nack", async () => {
    const queue = makeQueue();
    const fake = fakes.get(queue) as FakePubsub;
    await queue.producer.send("record", [
      { key: "a1", groupKey: "issue-a", body: 1 },
      { key: "b1", groupKey: "issue-b", body: 1 },
      { key: "a2", groupKey: "issue-a", body: 2 },
    ]);
    const seen: Delivery[] = [];
    const handle = (fail: boolean) => async (request: unknown) =>
      queue.push.handle(request as never, async (batch) => {
        seen.push(...batch);
        return batch.map((d) => ({
          deliveryId: d.id,
          action:
            fail && d.message.key === "a1"
              ? ("retry" as const)
              : ("ack" as const),
        }));
      });
    expect(await fake.push(subscription("record"), handle(true))).toEqual([
      503, 204,
    ]);
    expect(await fake.push(subscription("record"), handle(false))).toEqual([
      204, 204,
    ]);
    expect(seen.map((d) => `${d.message.key}:${d.attempt}`)).toEqual([
      "a1:1",
      "b1:1",
      "a1:2",
      "a2:1",
    ]);
  });
});
