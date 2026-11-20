import { readdir } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { findLayeringViolations } from "./layering.mjs";

const files = [];
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name))
      await collect(path);
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name))
      files.push(path);
  }
}
for (const name of ["core", "http"]) await collect(join("packages", name));
const program = ts.createProgram(files, {
  allowJs: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
});
const violations = program
  .getSourceFiles()
  .filter((source) => files.includes(source.fileName))
  .flatMap((source) => findLayeringViolations(program, source));
for (const violation of violations) console.error(violation);
if (violations.length) process.exitCode = 1;
