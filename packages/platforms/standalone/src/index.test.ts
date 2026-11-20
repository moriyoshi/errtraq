import {
  MemoryActiveStore,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@errtraq/testing";
import { describe, expect, it } from "vitest";
import { create, cronMatches } from "./index.js";
import { configSchema, standalone } from "./stack.js";

describe("standalone platform", () => {
  it("defaults to loopback and rejects unsupported jobs before starting", async () => {
    expect(configSchema.parse({}).host).toBe("127.0.0.1");
    expect(standalone().manifest).toMatchObject({
      runtime: "node",
      compute: "long-lived",
      functions: ["ingest", "api", "consumer", "cron"],
    });
    const platform = create(
      { port: 0 },
      {
        store: new MemoryActiveStore(),
        blobs: new MemoryBlobStore(),
        kv: new MemoryKV(),
        queue: new MemoryQueue(),
        jobs: [{ name: "bad", schedule: "not-cron" }],
      },
    );
    await expect(platform.start()).rejects.toThrow(
      "Unsupported cron expression",
    );
    const missingIdle = create(
      { port: 0 },
      {
        store: new MemoryActiveStore(),
        blobs: new MemoryBlobStore(),
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
