import { constructionOrder, selections } from "@errtraq/core";
import { expect, it } from "vitest";
import local from "../../../stacks/local.js";
import { constructStack } from "./construction.js";

const copyStack = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value)) as T;

const roles = ["ingest", "api", "consumer", "cron"] as const;
const selected = selections(local);
const pathByModule = new Map(
  [...selected].map(([path, selection]) => [selection.runtimeModule, path]),
);

it("passes queue mappings only to the queue and closes all instances in reverse order", async () => {
  const events: string[] = [];
  const contexts = new Map<string, Record<string, unknown>>();
  const built = await constructStack(local, roles, {}, async (specifier) => ({
    create(context: Record<string, unknown>) {
      const path = pathByModule.get(specifier);
      if (!path) throw new Error("Unknown test module");
      events.push(`create:${path}`);
      contexts.set(path, context);
      return {
        close: () => {
          events.push(`close:${path}`);
        },
      };
    },
  }));
  const order = constructionOrder(local);
  expect(events).toEqual(order.map((path) => `create:${path}`));
  for (const [path, context] of contexts) {
    const isQueue = selected.get(path)?.manifest.kind === "queue";
    expect(Object.hasOwn(context, "topics")).toBe(isQueue);
    expect(Object.hasOwn(context, "queueConsumers")).toBe(isQueue);
  }
  const queuePath = [...selected].find(
    ([, selection]) => selection.manifest.kind === "queue",
  )?.[0];
  if (!queuePath) throw new Error("Missing queue");
  expect(contexts.get(queuePath)?.queueConsumers).toEqual([
    {
      eventSource: "memory",
      physical: "memory",
      topics: ["ingest"],
    },
  ]);
  await built.close();
  await built.close();
  expect(events.slice(order.length)).toEqual(
    [...order].reverse().map((path) => `close:${path}`),
  );
});

it("closes every earlier adapter on a construction failure, even when a close fails", async () => {
  const events: string[] = [];
  const order = constructionOrder(local);
  const failed = order.at(-1);
  await expect(
    constructStack(local, roles, {}, async (specifier) => ({
      create() {
        const path = pathByModule.get(specifier);
        if (!path) throw new Error("Unknown test module");
        if (path === failed) throw new Error("creation failed");
        return {
          close() {
            events.push(path);
            if (path === order[1]) throw new Error("close failed");
          },
        };
      },
    })),
  ).rejects.toThrow("Construction and cleanup failed");
  expect(events).toEqual(order.slice(0, -1).reverse());
});

it("passes distinct event sources and topics for per-topic queue consumers", async () => {
  const stack = {
    ...copyStack(local),
    queue: {
      ...local.queue,
      infra: {
        ...local.queue.infra,
        resources: {
          events: "event-source-a",
          archive: "event-source-b",
          notifications: "event-source-c",
        },
        capabilities: {
          produce: { events: null, archive: null, notifications: null },
          consume: { events: null, archive: null, notifications: null },
        },
        topics: {
          mode: "per-topic" as const,
          routes: {
            ingest: { physical: "events" },
            "archive.project": { physical: "archive" },
            notifications: { physical: "notifications" },
          },
        },
      },
    },
  };
  let consumers: unknown;
  const built = await constructStack(stack, roles, {}, async (specifier) => ({
    create(context: Record<string, unknown>) {
      if (pathByModule.get(specifier) === "queue")
        consumers = context.queueConsumers;
      return {};
    },
  }));
  expect(consumers).toEqual([
    { physical: "events", eventSource: "event-source-a", topics: ["ingest"] },
  ]);
  await built.close();
});

it("passes disabled rate-rejection settings to the standalone platform only", async () => {
  const stack = {
    ...copyStack(local),
    rateRejection: { onKvFailure: "retry" as const },
  };
  const contexts = new Map<string, Record<string, unknown>>();
  const built = await constructStack(stack, roles, {}, async (specifier) => ({
    create(context: Record<string, unknown>) {
      const path = pathByModule.get(specifier);
      if (!path) throw new Error("Unknown module");
      contexts.set(path, context);
      return {};
    },
  }));
  expect(contexts.get("platform")?.rateRejection).toEqual({
    onKvFailure: "retry",
  });
  for (const [path, context] of contexts)
    if (path !== "platform")
      expect(context).not.toHaveProperty("rateRejection");
  await built.close();
});
