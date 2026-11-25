import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { BatchHandler, Delivery, Queue } from "@moriyoshi/errtraq-core";
import { queueContract } from "@moriyoshi/errtraq-testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PubsubQueue } from "./runtime.js";

/**
 * Opt-in: ERRTRAQ_PUBSUB_EMULATOR=<host:port> of the Cloud SDK Pub/Sub emulator
 * (see GCP_PLAN D6; the image is pinned in the JOURNAL entry for G2).
 * ERRTRAQ_PUBSUB_PUSH_HOST is the host name the emulator uses to reach this
 * process (default host.docker.internal for a containerised emulator).
 * The emulator does not send OIDC tokens, so pushAuth is "none" here.
 */
const emulator = process.env.ERRTRAQ_PUBSUB_EMULATOR;
const pushHost = process.env.ERRTRAQ_PUBSUB_PUSH_HOST ?? "host.docker.internal";
if (emulator && !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator))
  throw new Error("Pub/Sub emulator must be loopback host:port");
const project = "errtraq-test";
const origin = `http://${emulator}`;

async function admin(method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}/v1/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`emulator ${method} ${path}: ${await response.text()}`);
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

type Push = { handle: (body: string) => Promise<number> };
/** One local listener; routes by the subscription named in each push body. */
class Receiver {
  readonly routes = new Map<string, Push>();
  readonly unrouted: string[] = [];
  readonly attempts = new Map<string, number>();
  readonly server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let status = 503;
      try {
        const subscription = (JSON.parse(text) as { subscription: string })
          .subscription;
        const route = this.routes.get(subscription);
        if (route) {
          // The emulator never sends deliveryAttempt (a gap, see the G2
          // JOURNAL entry); count deliveries here the way a real
          // subscription with a dead-letter policy reports them.
          const body = JSON.parse(text) as {
            message: { messageId: string };
            deliveryAttempt?: number;
          };
          const id = `${subscription}|${body.message.messageId}`;
          const attempt = (this.attempts.get(id) ?? 0) + 1;
          this.attempts.set(id, attempt);
          status = await route.handle(
            JSON.stringify({ ...body, deliveryAttempt: attempt }),
          );
        } else this.unrouted.push(subscription);
      } catch {
        status = 400;
      }
      res.statusCode = status;
      res.end();
    });
  });
  port = 0;
  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "0.0.0.0", resolve),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }
  close() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
const receiver = new Receiver();

type Fixture = {
  queue: PubsubQueue;
  subscriptions: Record<string, string>;
  current: BatchHandler | undefined;
  handled: number;
  lastPush: number;
  deadLetterSubscription?: string;
};
const fixtures = new WeakMap<Queue, Fixture>();

async function makeQueue(
  options: { maxDeliveryAttempts?: number; withDeadLetter?: boolean } = {},
) {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  const names = { shared: `shared-${id}`, record: `record-${id}` };
  const topic = (name: string) => `projects/${project}/topics/${name}`;
  const subscription = (name: string) =>
    `projects/${project}/subscriptions/${name}`;
  const fixture = {
    subscriptions: {
      shared: subscription(names.shared),
      record: subscription(names.record),
    },
    current: undefined,
    handled: 0,
    lastPush: 0,
  } as unknown as Fixture;
  const deadTopic = topic(`dead-${id}`);
  await admin("PUT", deadTopic, {});
  if (options.withDeadLetter) {
    fixture.deadLetterSubscription = subscription(`dead-${id}`);
    await admin("PUT", fixture.deadLetterSubscription, { topic: deadTopic });
  }
  for (const [physical, name] of Object.entries(names)) {
    await admin("PUT", topic(name), {});
    await admin("PUT", subscription(name), {
      topic: topic(name),
      ackDeadlineSeconds: 10,
      enableMessageOrdering: physical === "record",
      pushConfig: {
        pushEndpoint: `http://${pushHost}:${receiver.port}/push/${physical}`,
      },
      retryPolicy: { minimumBackoff: "1s", maximumBackoff: "2s" },
      // deliveryAttempt is only populated with a dead-letter policy.
      deadLetterPolicy: {
        deadLetterTopic: deadTopic,
        maxDeliveryAttempts: options.maxDeliveryAttempts ?? 5,
      },
    });
  }
  const queue = new PubsubQueue({
    projectId: project,
    region: "us-central1",
    endpoint: origin,
    bindings: { SHARED: topic(names.shared), RECORD: topic(names.record) },
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
        eventSource: fixture.subscriptions.shared,
        topics: ["ingest", "archive.project", "contract"],
      },
      {
        physical: "record",
        eventSource: fixture.subscriptions.record,
        topics: ["record"],
      },
    ],
    // The emulator sends no OIDC token: tests and emulators only.
    allowUnauthenticatedPush: true,
  });
  fixture.queue = queue;
  for (const subscriptionName of Object.values(fixture.subscriptions))
    receiver.routes.set(subscriptionName, {
      handle: async (text) => {
        const handler = fixture.current;
        // No active driver: nack without telling the handler.
        if (!handler) return 503;
        const response = await queue.push.handle(
          { method: "POST", headers: {}, body: text },
          handler,
        );
        fixture.handled++;
        fixture.lastPush = Date.now();
        return response.status;
      },
    });
  fixtures.set(queue, fixture);
  return queue;
}

/** Arm the receiver with a handler; pushes arriving while armed reach it. */
function arm(queue: Queue, handler: BatchHandler) {
  const fixture = fixtures.get(queue);
  if (!fixture) throw new Error("Missing fixture");
  fixture.current = handler;
  return fixture;
}
/** Wait until pushes go quiet (or none arrive within waitMs), then disarm. */
async function settle(
  queue: Queue,
  start: number,
  before: number,
  { waitMs = 4000, idleMs = 700 } = {},
) {
  const fixture = fixtures.get(queue);
  if (!fixture) throw new Error("Missing fixture");
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const now = Date.now();
      if (fixture.handled === before) {
        if (now - start > waitMs) return;
      } else if (now - fixture.lastPush > idleMs) return;
    }
  } finally {
    fixture.current = undefined;
  }
}
/** Drive the receiver with a handler until pushes go quiet. */
async function drive(queue: Queue, handler: BatchHandler, options = {}) {
  const fixture = arm(queue, handler);
  await settle(queue, Date.now(), fixture.handled, options);
}

async function pullDeadLetters(subscription: string) {
  const result = await admin("POST", `${subscription}:pull`, {
    maxMessages: 10,
  });
  return (result.receivedMessages ?? []) as {
    ackId: string;
    message: { data: string; attributes: Record<string, string> };
  }[];
}

describe.skipIf(!emulator)("Pub/Sub emulator", { timeout: 60000 }, () => {
  beforeAll(() => receiver.start());
  afterAll(() => receiver.close());
  queueContract(() => makeQueue(), {
    deliverPush: (queue, handler) => drive(queue, handler),
  });
  it("preserves per-key order across nacks on an ordered subscription", async () => {
    const queue = await makeQueue();
    await queue.producer.send("record", [
      { key: "a1", groupKey: "issue-a", body: 1 },
      { key: "a2", groupKey: "issue-a", body: 2 },
      { key: "a3", groupKey: "issue-a", body: 3 },
    ]);
    const seen: string[] = [];
    const failedOnce = new Set<string>();
    await drive(
      queue,
      async (batch: Delivery[]) =>
        batch.map((d) => {
          seen.push(`${d.message.key}:${d.attempt}`);
          if (d.message.key === "a1" && !failedOnce.has("a1")) {
            failedOnce.add("a1");
            return { deliveryId: d.id, action: "retry" as const };
          }
          return { deliveryId: d.id, action: "ack" as const };
        }),
      { waitMs: 12000, idleMs: 3500 },
    );
    // a2 and a3 must never be delivered before a1 is acknowledged.
    const firstAck = seen.findIndex((s) => s.startsWith("a1:") && s !== "a1:1");
    expect(seen[0]).toBe("a1:1");
    expect(seen.indexOf("a2:1")).toBeGreaterThan(firstAck);
    expect(
      seen.filter((s) => s.startsWith("a")).map((s) => s.split(":")[0]),
    ).toEqual(["a1", "a1", "a2", "a3"]);
  }, 30000);
  it("dead-letters a message after maxDeliveryAttempts and counts attempts", async () => {
    const queue = await makeQueue({
      maxDeliveryAttempts: 5,
      withDeadLetter: true,
    });
    const attempts: number[] = [];
    const fixture = arm(queue, async (batch) => {
      attempts.push(...batch.map((d) => d.attempt));
      return batch.map((d) => ({
        deliveryId: d.id,
        action: "retry" as const,
      }));
    });
    const start = Date.now();
    await queue.producer.send("ingest", [{ key: "dead", body: 1 }]);
    await settle(queue, start, fixture.handled, {
      waitMs: 25000,
      idleMs: 8000,
    });
    expect(attempts[0]).toBe(1);
    expect(
      attempts.every((a, i) => i === 0 || a > (attempts[i - 1] ?? 0)),
    ).toBe(true);
    const dead = await pullDeadLetters(fixture.deadLetterSubscription ?? "");
    console.info(
      "pubsub emulator dead-letter attempts",
      attempts,
      "dead",
      dead.length,
    );
    expect(dead.length).toBe(1);
    expect(dead[0]?.message.attributes["errtraq-topic"]).toBe("ingest");
  }, 60000);
  it("nacks a push that fails to decode instead of acknowledging it", async () => {
    const queue = await makeQueue();
    const fixture = fixtures.get(queue);
    // Publish a raw message the adapter cannot decode (no errtraq-topic).
    await admin(
      "POST",
      `${fixture?.subscriptions.shared.replace("/subscriptions/", "/topics/")}:publish`,
      {
        messages: [{ data: btoa("not json") }],
      },
    );
    let called = false;
    await drive(queue, async (batch) => {
      called = true;
      return batch.map((d) => ({ deliveryId: d.id, action: "ack" as const }));
    });
    expect(called).toBe(false);
  }, 20000);
});
