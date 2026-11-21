import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";
import { findLayeringViolations, workersReachable } from "./layering.mjs";
import { checkWorkerBundle } from "./worker-bundle.mjs";

const files = [];
const packageNames = {};
const workerEntries = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name))
      await collect(path);
    else if (entry.isFile() && entry.name === "package.json") {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      if (manifest.name) packageNames[manifest.name] = directory;
      if (manifest.errtraqWorkersRuntime)
        workerEntries.push(join(directory, manifest.errtraqWorkersRuntime));
    } else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
      files.push(path);
  }
}
await collect("packages");
const program = ts.createProgram(files, {
  allowJs: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  customConditions: ["development"],
  skipLibCheck: true,
  types: [],
  lib: ["lib.es2022.d.ts", "lib.webworker.d.ts"],
});
const workers = workersReachable(program, workerEntries);
const violations = program
  .getSourceFiles()
  .filter((source) => files.includes(source.fileName))
  .flatMap((source) =>
    findLayeringViolations(program, source, packageNames, {
      workers: workers.has(resolve(source.fileName)),
    }),
  );
for (const entry of workerEntries) {
  try {
    violations.push(...(await checkWorkerBundle(entry)));
  } catch (error) {
    violations.push(
      `${entry}: Workers dependency bundle failed: ${String(error)}`,
    );
  }
}
for (const violation of violations) console.error(violation);
if (violations.length) process.exitCode = 1;
