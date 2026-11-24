import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setVersion } from "./version.mjs";

let root;
async function manifest(directory, content) {
  await mkdir(join(root, "packages", directory), { recursive: true });
  await writeFile(
    join(root, "packages", directory, "package.json"),
    JSON.stringify(content),
  );
}
const read = async (directory) =>
  JSON.parse(
    await readFile(join(root, "packages", directory, "package.json"), "utf8"),
  );
beforeEach(async () => {
  await mkdir(resolve(".agents-workspace/tmp"), { recursive: true });
  root = await mkdtemp(resolve(".agents-workspace/tmp/version-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("version script", () => {
  it("sets every public package and leaves private ones alone", async () => {
    await manifest("core", {
      name: "@moriyoshi/errtraq-core",
      version: "0.0.0",
    });
    await manifest("adapters/kv", {
      name: "@moriyoshi/errtraq-kv",
      version: "0.0.0",
    });
    await manifest("testing", {
      name: "@moriyoshi/errtraq-testing",
      version: "0.0.0",
      private: true,
    });
    expect(await setVersion(root, "1.2.3")).toHaveLength(2);
    expect((await read("core")).version).toBe("1.2.3");
    expect((await read("adapters/kv")).version).toBe("1.2.3");
    expect((await read("testing")).version).toBe("0.0.0");
  });
  it("fails when public versions differ or the version is malformed", async () => {
    await manifest("core", {
      name: "@moriyoshi/errtraq-core",
      version: "0.0.0",
    });
    await manifest("http", {
      name: "@moriyoshi/errtraq-http",
      version: "0.1.0",
    });
    await expect(setVersion(root, "1.0.0")).rejects.toThrow(
      "different versions",
    );
    await expect(setVersion(root, "latest")).rejects.toThrow("semantic");
    expect((await read("core")).version).toBe("0.0.0");
  });
});
