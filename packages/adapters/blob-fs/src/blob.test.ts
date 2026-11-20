import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import {
  readFile,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { BlobCorruptError } from "@errtraq/core";
import { blobStoreContract } from "@errtraq/testing";
import { afterAll, expect, it, vi } from "vitest";
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

it("skips corrupted files at startup and reports corruption on direct access", async () => {
  const root = join(directory, "corrupt");
  const first = create({ root });
  await first.put("good", new TextEncoder().encode("ok"));
  await first.put("bad", new TextEncoder().encode("bad"));
  const bad = join(
    root,
    `object-${createHash("sha256").update("bad", "utf16le").digest("hex")}`,
  );
  const info = await stat(bad);
  await truncate(bad, info.size - 1);
  const zero = join(
    root,
    `object-${createHash("sha256").update("zero", "utf16le").digest("hex")}`,
  );
  await writeFile(zero, new Uint8Array());
  const log = vi.fn();
  const reopened = create({ root }, { logger: { warn: log } });
  expect((await reopened.list("")).items).toEqual(["good"]);
  expect(log).toHaveBeenCalled();
  await expect(reopened.get("bad")).rejects.toBeInstanceOf(BlobCorruptError);
  await expect(reopened.head("bad")).rejects.toBeInstanceOf(BlobCorruptError);
  await expect(reopened.get("zero")).rejects.toBeInstanceOf(BlobCorruptError);
});
it("cleans stale temp files and accepts a symlinked configured root", async () => {
  const root = join(directory, "real-root");
  mkdirSync(root);
  const stale = join(root, ".tmp-stale");
  await writeFile(stale, "x");
  const old = new Date(Date.now() - 7200000);
  await utimes(stale, old, old);
  const alias = join(directory, "root-link");
  await symlink(root, alias);
  const b = create({ root: alias });
  await b.put("key", new TextEncoder().encode("value"));
  await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await b.list("")).items).toEqual(["key"]);
});
