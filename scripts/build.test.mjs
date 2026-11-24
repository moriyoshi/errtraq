import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectDirectories, staleOutputs } from "./build.mjs";

let directory;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(files) {
  directory = await mkdtemp(join(tmpdir(), "errtraq-build-"));
  for (const [path, seconds] of Object.entries(files)) {
    const full = join(directory, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, "");
    await utimes(full, seconds, seconds);
  }
  return directory;
}

describe("build output freshness", () => {
  it("reports missing and older outputs, ignoring tests and declarations", async () => {
    const root = await fixture({
      "src/current.ts": 100,
      "dist/current.js": 200,
      "src/nested/old.ts": 300,
      "dist/nested/old.js": 200,
      "src/missing.ts": 100,
      "src/missing.test.ts": 300,
      "src/types.d.ts": 300,
    });
    expect((await staleOutputs(root)).sort()).toEqual([
      "missing.ts",
      "nested/old.ts",
    ]);
  });
  it("accepts an output emitted in the same instant as its source", async () => {
    expect(
      await staleOutputs(await fixture({ "src/a.ts": 100, "dist/a.js": 100 })),
    ).toEqual([]);
  });
  it("checks every project the root build references", async () => {
    const projects = await projectDirectories(process.cwd());
    expect(projects.length).toBeGreaterThan(10);
    expect(projects.some((path) => path.endsWith("packages/cli"))).toBe(true);
  });
});
