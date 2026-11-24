import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bootstrapProject, hashApiToken } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { devToken } from "../../cli/src/token.js";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryKV } from "./memory-other.js";
import { DeterministicIdGen } from "./shared.js";

describe("local API token", () => {
  it("reuses a private token and revokes it when rotated", async () => {
    const root = resolve(".agents-workspace/tmp");
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, "token-test-"));
    try {
      const store = new MemoryActiveStore(),
        ids = new DeterministicIdGen(),
        kv = new MemoryKV();
      const { org } = await bootstrapProject({
        store,
        kv,
        ids,
        orgSlug: "org",
        projectSlug: "project",
      });
      const first = await devToken(store, ids, org.id, dir);
      expect((await stat(join(dir, "api-token"))).mode & 0o777).toBe(0o600);
      expect(await devToken(store, ids, org.id, dir)).toBe(first);
      const second = await devToken(store, ids, org.id, dir, true);
      expect(second).not.toBe(first);
      expect(
        (await store.projects.getTokenByHash(await hashApiToken(first)))
          ?.revokedAt,
      ).toBeTruthy();
      expect(
        (await store.projects.getTokenByHash(await hashApiToken(second)))
          ?.revokedAt,
      ).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
