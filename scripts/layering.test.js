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
});
