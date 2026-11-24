import { bootstrapProject, readDropped } from "@moriyoshi/errtraq-core";
import {
  DeterministicIdGen,
  FakeClock,
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@moriyoshi/errtraq-testing";
import { describe, expect, it, vi } from "vitest";
import { create as createAdapter, cronMatches } from "./index.js";

const create = (
  config: Parameters<typeof createAdapter>[0]["config"],
  dependencies: Parameters<typeof createAdapter>[0]["dependencies"],
  cronJobs: string[] = [],
) =>
  createAdapter({ config, dependencies, bindings: {}, topics: {}, cronJobs });

import { configSchema, standalone } from "./stack.js";

describe("standalone platform", () => {
  it("exposes only the configured HTTP apps", async () => {
    for (const http of [["ingest"], ["api"]] as const) {
      const queue = Object.assign(new MemoryQueue(), {
        idle: async () => true,
      });
      const platform = create(
        { port: 0, http: [...http], publicUrl: "https://errors.example" },
        {
          store: new MemoryActiveStore(),
          blob: new MemoryBlobStore(),
          kv: new MemoryKV(),
          queue,
        },
      );
      const server = await platform.start();
      try {
        expect(server.publicUrl).toBe("https://errors.example");
        const base = `http://127.0.0.1:${server.port}`;
        const health = await fetch(`${base}/health`);
        expect(health.status).toBe(200);
        expect(await health.json()).toEqual({ status: "ok" });
        const ingest = await fetch(`${base}/api/1/envelope/`, {
          method: "POST",
        });
        const api = await fetch(`${base}/api/0/issues/123`);
        expect(ingest.status === 404).toBe(http[0] !== "ingest");
        expect(api.status === 404).toBe(http[0] !== "api");
      } finally {
        await platform.close();
      }
    }
  });
  it("defaults to loopback and rejects unsupported jobs before starting", async () => {
    expect(configSchema.parse({}).host).toBe("127.0.0.1");
    expect(
      configSchema.parse({ publicUrl: "https://errors.example" }).publicUrl,
    ).toBe("https://errors.example");
    expect(
      configSchema.safeParse({
        publicUrl: "https://user:password@errors.example",
      }).success,
    ).toBe(false);
    expect(
      configSchema.safeParse({ publicUrl: "https://errors.example/path" })
        .success,
    ).toBe(false);
    expect(configSchema.safeParse({ split: ["api"] }).success).toBe(false);
    expect(configSchema.safeParse({ roles: ["api"] }).success).toBe(false);
    expect(standalone().manifest).toMatchObject({
      runtime: "node",
      compute: "long-lived",
    });
    const platform = create(
      { port: 0 },
      {
        store: new MemoryActiveStore(),
        blob: new MemoryBlobStore(),
        kv: new MemoryKV(),
        queue: new MemoryQueue(),
      },
      ["bad"],
    );
    await expect(platform.start()).rejects.toThrow("Unknown cron job");
    const missingIdle = create(
      { port: 0 },
      {
        store: new MemoryActiveStore(),
        blob: new MemoryBlobStore(),
        kv: new MemoryKV(),
        queue: new MemoryQueue(),
      },
    );
    await expect(missingIdle.start()).rejects.toThrow("queue idle observation");
  });
  it("matches the supported cron expressions in UTC", () => {
    const at = new Date("2024-01-01T12:10:00Z");
    expect(cronMatches("*/5 12 * * 1", at)).toBe(true);
    expect(cronMatches("11 12 * * 1", at)).toBe(false);
    expect(cronMatches("10 12 */2 * *", at)).toBe(true);
    expect(cronMatches("10 12 2 * 1", at)).toBe(true);
    expect(cronMatches("10 12 */2 * 2", at)).toBe(false);
    expect(cronMatches("10 12 2 * */2", at)).toBe(false);
    expect(() => cronMatches("invalid", at)).toThrow();
  });
});

it("accepts grouped recording with the in-memory queue and record role", async () => {
  const { default: local } = await import("../../../../stacks/local.js");
  const { resolveStack, deriveDeployment } = await import(
    "@moriyoshi/errtraq-core"
  );
  const { standalone } = await import("./stack.js");
  const stack = resolveStack({
    ...Object.fromEntries(Object.entries(local)),
    recordMode: "grouped",
    platform: standalone({
      roles: ["ingest", "api", "consumer", "record", "cron"],
    }),
  });
  expect(deriveDeployment(stack).functions[0]?.roles).toContain("record");
});

it("enforces an issue limit through the standalone HTTP and queue pipeline", async () => {
  const store = new MemoryActiveStore();
  const clock = new FakeClock();
  const kv = new MemoryKV(clock);
  const queue = Object.assign(new MemoryQueue(clock), {
    idle: async () => true,
  });
  const project = await bootstrapProject({
    store,
    kv,
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "project",
  });
  const rateRejection = { issueRateLimit: { events: 1, windowSec: 60 } };
  const platform = createAdapter({
    config: { port: 0 },
    dependencies: { store, kv, queue, blob: new MemoryBlobStore(), clock },
    bindings: {},
    topics: {},
    rateRejection,
  });
  const server = await platform.start();
  try {
    for (const n of [1, 2]) {
      const eventId = n.toString(16).padStart(32, "0");
      const body = `${JSON.stringify({ event_id: eventId })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: eventId, message: "same issue" })}\n`;
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/${project.project.id}/envelope/?sentry_key=${project.key.publicKey}`,
        {
          method: "POST",
          body,
          headers: { "Content-Type": "application/x-sentry-envelope" },
        },
      );
      expect(response.status).toBe(200);
    }
    await vi.waitFor(async () => {
      const page = await store.issues.list({
        projectId: project.project.id,
        sort: "lastSeen",
      });
      expect(page.items).toHaveLength(1);
      const issue = page.items[0];
      if (!issue) throw new Error("Issue not recorded yet");
      expect(issue.count).toBe(1);
      expect(
        await readDropped(
          kv,
          rateRejection,
          project.project.id,
          issue.id,
          clock.now(),
        ),
      ).toEqual({ count: 1, windowSec: 60 });
    });
  } finally {
    await platform.close();
  }
});

it("enforces a project's tighter issue limit in grouped mode, where the consumer only reads projects", async () => {
  const store = new MemoryActiveStore();
  const clock = new FakeClock();
  const kv = new MemoryKV(clock);
  const queue = Object.assign(new MemoryQueue(clock), {
    idle: async () => true,
  });
  const project = await bootstrapProject({
    store,
    kv,
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "project",
  });
  await store.projects.put({
    ...project.project,
    rateLimits: { issueEvents: 1 },
  });
  const rateRejection = { issueRateLimit: { events: 5, windowSec: 60 } };
  const platform = createAdapter({
    config: { port: 0 },
    dependencies: { store, kv, queue, blob: new MemoryBlobStore(), clock },
    bindings: {},
    topics: {},
    recordMode: "grouped",
    rateRejection,
  });
  const server = await platform.start();
  try {
    for (const n of [1, 2, 3]) {
      const eventId = n.toString(16).padStart(32, "0");
      const body = `${JSON.stringify({ event_id: eventId })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: eventId, message: "same issue" })}\n`;
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/${project.project.id}/envelope/?sentry_key=${project.key.publicKey}`,
        {
          method: "POST",
          body,
          headers: { "Content-Type": "application/x-sentry-envelope" },
        },
      );
      expect(response.status).toBe(200);
    }
    await vi.waitFor(async () => {
      const page = await store.issues.list({
        projectId: project.project.id,
        sort: "lastSeen",
      });
      const issue = page.items[0];
      if (!issue) throw new Error("Issue not recorded yet");
      expect(issue.count).toBe(1);
      expect(
        await readDropped(
          kv,
          rateRejection,
          project.project.id,
          issue.id,
          clock.now(),
        ),
      ).toEqual({ count: 2, windowSec: 60 });
    });
  } finally {
    await platform.close();
  }
});
