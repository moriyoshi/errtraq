import { createRequire } from "node:module";
import ts from "typescript";
import { findLayeringViolations } from "./layering.mjs";

const require = createRequire(
  new URL("../packages/cli/package.json", import.meta.url),
);
const { build } = require("esbuild");
/** Check bundled dependency code as well as the repository's transitive sources. */
export async function checkWorkerBundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "esm",
    conditions: ["development"],
    write: false,
    logLevel: "silent",
  });
  const name = "worker-bundle.mjs",
    code = result.outputFiles[0].text;
  const options = { allowJs: true, noEmit: true, noLib: true, types: [] };
  const host = ts.createCompilerHost(options),
    original = host.getSourceFile;
  host.getSourceFile = (file, ...args) =>
    file === name
      ? ts.createSourceFile(
          name,
          code,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        )
      : original(file, ...args);
  const program = ts.createProgram([name], options, host);
  return findLayeringViolations(
    program,
    program.getSourceFile(name),
    {},
    { workers: true },
  );
}
