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
  it("defaults to loopback and rejects unsupported jobs before starting", async () => {
    expect(configSchema.parse({}).host).toBe("127.0.0.1");
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
