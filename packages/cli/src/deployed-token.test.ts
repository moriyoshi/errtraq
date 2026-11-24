import type { ApiTokenId, OrgId, Timestamp } from "@errtraq/core";
import { MemoryActiveStore } from "@errtraq/testing";
import { describe, expect, it } from "vitest";
import { formatTokens, listTokens, revokeToken } from "./deployed-token.js";

async function fixture() {
  const store = new MemoryActiveStore();
  const orgId = "org-1" as OrgId;
  await store.projects.putOrg({ id: orgId, slug: "acme", name: "Acme" });
  const add = (id: string, extra: object = {}) =>
    store.projects.putToken({
      id: id as ApiTokenId,
      orgId,
      tokenHash: `hash-${id}`,
      scopes: ["event:read"],
      ...extra,
    });
  return { store, orgId, add };
}
const now = () => new Date("2025-01-01T00:00:00.000Z");

describe("deployed token management", () => {
  it("lists metadata without hashes and prints a table", async () => {
    const f = await fixture();
    await f.add("a", {
      label: "bootstrap",
      createdAt: "2024-12-01T00:00:00.000Z",
    });
    await f.add("b");
    const tokens = await listTokens(f.store, "acme");
    expect(tokens.map((t) => t.id)).toEqual(["a", "b"]);
    const text = formatTokens(tokens);
    expect(text).toContain("bootstrap");
    expect(text).toContain("created unknown");
    expect(text).not.toContain("hash-");
    await expect(listTokens(f.store, "nope")).rejects.toThrow(/does not exist/);
  });
  it("revokes idempotently and refuses the last active token without force", async () => {
    const f = await fixture();
    await f.add("a");
    await f.add("b");
    const first = await revokeToken(f.store, { orgSlug: "acme", id: "a" }, now);
    expect(first.revokedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(
      (await f.store.projects.getTokenByHash("hash-a"))?.revokedAt,
    ).toBeDefined();
    // Repeating a revoke is a no-op even though only one token remains.
    expect(
      (await revokeToken(f.store, { orgSlug: "acme", id: "a" }, now)).revokedAt,
    ).toBe(first.revokedAt);
    await expect(
      revokeToken(f.store, { orgSlug: "acme", id: "b" }, now),
    ).rejects.toThrow(/last active/);
    expect(
      (await f.store.projects.getTokenByHash("hash-b"))?.revokedAt,
    ).toBeUndefined();
    const forced = await revokeToken(
      f.store,
      { orgSlug: "acme", id: "b", force: true },
      now,
    );
    expect(forced.revokedAt).toBe("2025-01-01T00:00:00.000Z" as Timestamp);
    await expect(
      revokeToken(f.store, { orgSlug: "acme", id: "zzz", force: true }, now),
    ).rejects.toThrow(/does not exist/);
  });
});
