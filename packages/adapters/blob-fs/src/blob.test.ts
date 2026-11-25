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
import { BlobCorruptError, BlobInvalidKeyError } from "@moriyoshi/errtraq-core";
import { blobStoreContract } from "@moriyoshi/errtraq-testing";
import { afterAll, expect, it, vi } from "vitest";
import { create as createAdapter, FsBlobStore } from "./index.js";

const create = (
  config: Parameters<typeof createAdapter>[0]["config"] = {} as Parameters<
    typeof createAdapter
  >[0]["config"],
  bindings: Parameters<typeof createAdapter>[0]["bindings"] = {},
) => createAdapter({ config, bindings, dependencies: {}, topics: {} });

const parent = join(process.cwd(), ".agents-workspace", "tmp");
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, "m1b-blob-"));
let sequence = 0;
blobStoreContract(() =>
  create({ root: join(directory, `root-${++sequence}`) }),
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
it("rejects traversal and control keys while safely encoding absolute-looking keys", async () => {
  const b = create({ root: join(directory, "encoded") });
  for (const key of ["../escape", "a/../../outside", "a\0b"])
    await expect(b.put(key, new Uint8Array())).rejects.toBeInstanceOf(
      BlobInvalidKeyError,
    );
  const key = "/absolute/path";
  await b.put(key, new TextEncoder().encode(key));
  const data = await b.get(key);
  if (!data) throw new Error("Missing object");
  expect(await new Response(data).text()).toBe(key);
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

it("ignores a file removed between directory scan and opening it", async () => {
  const root = join(directory, "scan-delete-race");
  const first = create({ root });
  await first.put("gone", new Uint8Array([1]));
  const log = vi.fn();
  const reopened = new FsBlobStore({ root }, { warn: log }, async () => {
    const error = Object.assign(new Error("deleted"), { code: "ENOENT" });
    throw error;
  });
  expect((await reopened.list("")).items).toEqual([]);
  expect(log).not.toHaveBeenCalled();
});
it("expires only objects under the prefix that are older than the cutoff", async () => {
  const root = join(directory, "expire");
  const b = create({ root });
  const bytes = new TextEncoder().encode("x");
  await b.put("artifacts/chunks/org/old", bytes);
  await b.put("artifacts/chunks/org/new", bytes);
  await b.put("artifacts/bundles/1/old", bytes);
  const { readdir } = await import("node:fs/promises");
  const old = new Date(Date.now() - 10 * 86400000);
  for (const name of await readdir(root)) {
    // Age every object, then re-touch the one that must survive.
    await utimes(join(root, name), old, old);
  }
  await b.put("artifacts/chunks/org/new", bytes);
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  expect(await b.expireOlderThan("artifacts/chunks/", cutoff)).toBe(1);
  expect(await b.head("artifacts/chunks/org/old")).toBeNull();
  expect(await b.head("artifacts/chunks/org/new")).not.toBeNull();
  expect(await b.head("artifacts/bundles/1/old")).not.toBeNull();
  await expect(b.expireOlderThan("artifacts/", "nope")).rejects.toThrow(
    RangeError,
  );
});
it("reaches old objects that sort after many fresh ones across bounded calls", async () => {
  const root = join(directory, "expire-paged");
  const b = create({ root });
  const bytes = new TextEncoder().encode("x");
  await b.put("artifacts/chunks/z-old", bytes);
  const { readdir } = await import("node:fs/promises");
  const old = new Date(Date.now() - 10 * 86400000);
  for (const name of await readdir(root))
    await utimes(join(root, name), old, old);
  for (let i = 0; i < 7; i++) await b.put(`artifacts/chunks/a${i}`, bytes);
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  let removed = 0;
  let calls = 0;
  while (!removed && calls < 4) {
    calls++;
    removed = await b.expireOlderThan("artifacts/chunks/", cutoff, {
      scanLimit: 3,
    });
  }
  // 8 keys at 3 per call: the old key is the 8th, reached by the third call.
  expect(calls).toBe(3);
  expect(removed).toBe(1);
  expect(await b.head("artifacts/chunks/z-old")).toBeNull();
  expect(await b.head("artifacts/chunks/a0")).not.toBeNull();
  await expect(
    b.expireOlderThan("artifacts/chunks/", cutoff, { scanLimit: 0 }),
  ).rejects.toThrow(RangeError);
});
