import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// `tsc -b` (TypeScript 5.6+) trusts each project's .tsbuildinfo and never checks that the
// emitted files still exist or are current, so a deleted or overwritten dist/ survives a build.
// The CLI runs from dist/, so verify every source has a JavaScript output at least as new.

/** Sources under `<package>/src` whose `dist` output is missing or older than the source. */
export async function staleOutputs(packageDirectory) {
  const stale = [];
  const walk = async (relative) => {
    const entries = await readdir(join(packageDirectory, "src", relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        const source = await stat(join(packageDirectory, "src", path));
        const output = await stat(
          join(packageDirectory, "dist", path.replace(/\.ts$/, ".js")),
        ).catch(() => undefined);
        if (!output || output.mtimeMs < source.mtimeMs) stale.push(path);
      }
    }
  };
  await walk("");
  return stale;
}
export async function projectDirectories(root) {
  const config = JSON.parse(
    await readFile(join(root, "tsconfig.json"), "utf8"),
  );
  return config.references.map((reference) => resolve(root, reference.path));
}
async function staleProjects(root) {
  const result = [];
  for (const directory of await projectDirectories(root)) {
    const stale = await staleOutputs(directory);
    if (stale.length) result.push({ directory, stale });
  }
  return result;
}
function tsc(...args) {
  const run = spawnSync("tsc", ["-b", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
async function run() {
  const root = process.cwd();
  tsc();
  const stale = await staleProjects(root);
  if (!stale.length) return;
  for (const { directory, stale: files } of stale)
    console.log(
      `Stale build output in ${directory.slice(root.length + 1)}: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}; rebuilding`,
    );
  tsc("--force", ...stale.map(({ directory }) => directory));
  const remaining = await staleProjects(root);
  if (remaining.length) {
    console.error(
      `Build output is still older than its sources in ${remaining.map(({ directory }) => directory.slice(root.length + 1)).join(", ")}`,
    );
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await run();
