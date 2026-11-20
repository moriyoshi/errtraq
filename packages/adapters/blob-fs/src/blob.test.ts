import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { blobStoreContract } from "@errtraq/testing";
import { afterAll, expect, it } from "vitest";
import { create } from "./index.js";

const parent = join(process.cwd(), ".agents-workspace", "tmp");
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, "m1b-blob-"));
let sequence = 0;
blobStoreContract(() =>
  create({ root: join(directory, `root-${++sequence}`) }),
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
it("encodes unsafe keys without leaving the root", async () => {
  const root = join(directory, "encoded");
  const b = create({ root });
  for (const key of [
    "../escape",
    "/absolute/path",
    "a/../../outside",
    "a\0b",
  ]) {
    await b.put(key, new TextEncoder().encode(key));
    const data = await b.get(key);
    expect(data).not.toBeNull();
    if (data) expect(await new Response(data).text()).toBe(key);
  }
});
it("does not follow object symlinks", async () => {
  const root = join(directory, "symlinks");
  const b = create({ root });
  await b.put("init", new Uint8Array());
  const outside = join(directory, "outside");
  await writeFile(outside, "unchanged");
  const key = "danger";
  const name = `object-${createHash("sha256").update(key, "utf16le").digest("hex")}`;
  await symlink(outside, join(root, name));
  await expect(b.get(key)).rejects.toThrow();
  await b.put(key, new TextEncoder().encode("safe"));
  expect(await readFile(outside, "utf8")).toBe("unchanged");
});

it("leaves the old object intact if a replacement write fails", async () => {
  const b = create({ root: join(directory, "atomic") });
  await b.put("item", new TextEncoder().encode("old"));
  await expect(
    b.put("item", new TextEncoder().encode("new"), { size: 10 }),
  ).rejects.toThrow("Size mismatch");
  const result = await b.get("item");
  if (!result) throw new Error("Missing object");
  expect(await new Response(result).text()).toBe("old");
});
