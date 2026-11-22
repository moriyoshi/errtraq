import {
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@errtraq/testing";
import { describe, expect, it } from "vitest";
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
  const { resolveStack, deriveDeployment } = await import("@errtraq/core");
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

it("refuses to start with an unenforced rate-rejection limit", () => {
  expect(() =>
    createAdapter({
      config: {},
      bindings: {},
      dependencies: {} as Parameters<typeof createAdapter>[0]["dependencies"],
      rateRejection: { newIssueCap: { issues: 1, windowSec: 60 } },
    }),
  ).toThrow("Rate rejection limits are not implemented yet");
});
