import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { findLayeringViolations } from "./layering.mjs";

const files = [];
const packageNames = {};
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name))
      await collect(path);
    else if (entry.isFile() && entry.name === "package.json") {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      if (manifest.name) packageNames[manifest.name] = directory;
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
  skipLibCheck: true,
  types: [],
  lib: ["lib.es2022.d.ts", "lib.webworker.d.ts"],
});
const violations = program
  .getSourceFiles()
  .filter((source) => files.includes(source.fileName))
  .flatMap((source) => findLayeringViolations(program, source, packageNames));
for (const violation of violations) console.error(violation);
if (violations.length) process.exitCode = 1;
