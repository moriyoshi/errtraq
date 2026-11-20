import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findLayeringViolations } from "./layering.mjs";

function check(code) {
  const name = "fixture.ts";
  const options = { noLib: true };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (file, ...args) =>
    file === name
      ? ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true)
      : original(file, ...args);
  const program = ts.createProgram([name], options, host);
  return findLayeringViolations(program, program.getSourceFile(name));
}
describe("layering checker", () => {
  it("permits property names and locally bound identifiers", () => {
    expect(
      check(
        "const foo = { process() {}, Buffer: 1 }; foo.process(); function f(process: string) { return process; }",
      ),
    ).toEqual([]);
  });
  it("rejects Node imports and global references", () => {
    expect(
      check(
        'import "node:fs"; process.exit(); Buffer.from("x"); globalThis.process; globalThis["Buffer"];',
      ),
    ).toHaveLength(5);
  });
  it.each([
    'import fs from "fs"',
    'import process from "process"',
    'import { createRequire } from "node:module"',
    'require("fs")',
    'createRequire("x")',
    "import(somePath)",
    "const g = globalThis; g.process",
    "global.foo",
    "__dirname",
    "setImmediate(() => {})",
    'import sdk from "@aws-sdk/client-s3"',
  ])("rejects %s", (input) => {
    expect(check(input).length).toBeGreaterThan(0);
  });
  it("rejects adapter and platform imports", () => {
    const source = ts.createSourceFile(
      "packages/adapters/a/src/a.ts",
      'import "../../b/src/index.js"; import "../../../platforms/x/src/index.js"',
      ts.ScriptTarget.Latest,
      true,
    );
    const program = ts.createProgram([], { noLib: true });
    expect(findLayeringViolations(program, source).length).toBe(2);
    const named = ts.createSourceFile(
      "packages/adapters/a/src/a.ts",
      'import "@errtraq/store-b"; import "@errtraq/cloudflare"',
      ts.ScriptTarget.Latest,
      true,
    );
    expect(
      findLayeringViolations(program, named, {
        "@errtraq/store-b": "packages/adapters/b",
        "@errtraq/cloudflare": "packages/platforms/cloudflare",
      }).length,
    ).toBe(2);
  });
});

describe("Workers-only type environment", () => {
  it("rejects Node and DOM-only globals while allowing Workers globals", () => {
    const name = "worker-fixture.ts";
    const options = {
      noEmit: true,
      types: [],
      lib: ["lib.es2022.d.ts", "lib.webworker.d.ts"],
      skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options);
    const getSource = host.getSourceFile;
    host.getSourceFile = (file, ...args) =>
      file === name
        ? ts.createSourceFile(
            name,
            "fetch('/'); document.title; process.exit(); Buffer.from('x');",
            ts.ScriptTarget.Latest,
            true,
          )
        : getSource(file, ...args);
    const program = ts.createProgram([name], options, host);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === name);
    expect(diagnostics).toHaveLength(3);
  });
  it("does not reintroduce Node globals when a test imports Vitest", () => {
    const name = "packages/core/src/worker-fixture.test.ts";
    const options = {
      noEmit: true,
      types: [],
      lib: ["lib.es2022.d.ts", "lib.webworker.d.ts"],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile;
    host.getSourceFile = (file, ...args) =>
      file === name
        ? ts.createSourceFile(
            name,
            'import { it } from "vitest"; it("x", () => {}); process.exit(); Buffer.from("x"); document.title;',
            ts.ScriptTarget.Latest,
            true,
          )
        : original(file, ...args);
    const program = ts.createProgram([name], options, host);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName === name);
    expect(diagnostics).toHaveLength(3);
  });
});
