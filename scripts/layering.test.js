import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { findLayeringViolations, workersReachable } from "./layering.mjs";
import { checkWorkerBundle } from "./worker-bundle.mjs";

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
  it("allows platform internal imports but rejects other platform packages", () => {
    const source = ts.createSourceFile(
      "packages/platforms/a/src/index.ts",
      'import "./stack.js"; import "../../b/src/index.js"',
      ts.ScriptTarget.Latest,
      true,
    );
    const program = ts.createProgram([], { noLib: true });
    expect(findLayeringViolations(program, source)).toHaveLength(1);
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

describe("declared Workers runtime graph", () => {
  it("rejects Node imports in bundled dependencies", async () => {
    mkdirSync(".agents-workspace/tmp", { recursive: true });
    const dir = mkdtempSync(".agents-workspace/tmp/worker-dep-");
    try {
      const entry = join(dir, "entry.js"),
        dep = join(dir, "dependency.js");
      writeFileSync(entry, 'import "./dependency.js";');
      writeFileSync(dep, 'import "node:fs";');
      await expect(checkWorkerBundle(entry)).rejects.toThrow();
      writeFileSync(
        entry,
        'import { load } from "./dependency.js"; globalThis.load = load;',
      );
      writeFileSync(
        dep,
        "export function load(name) { return require(name); }",
      );
      expect((await checkWorkerBundle(entry)).length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks transitive value imports and excludes type-only helpers", () => {
    mkdirSync(".agents-workspace/tmp", { recursive: true });
    const dir = mkdtempSync(".agents-workspace/tmp/layering-");
    try {
      const entry = join(dir, "entry.ts"),
        inner = join(dir, "inner.ts"),
        types = join(dir, "stack.ts");
      writeFileSync(
        entry,
        'import "./inner.js"; import type { T } from "./stack.js"; export const value: T = 1;',
      );
      writeFileSync(inner, 'import "node:fs"; process.exit();');
      writeFileSync(types, "export type T = number; process.exit();");
      const options = {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: [],
      };
      const program = ts.createProgram([entry, inner, types], options);
      const reachable = workersReachable(program, [entry]);
      expect(reachable.has(resolve(inner))).toBe(true);
      expect(reachable.has(resolve(types))).toBe(false);
      const source = program.getSourceFile(inner);
      expect(
        findLayeringViolations(program, source, {}, { workers: true }),
      ).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
