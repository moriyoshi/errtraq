import { describe, expect, it } from "vitest";
import { containsLocalPath } from "./path-hygiene.js";

describe("local path detection", () => {
  it("treats only complete multi-component paths as local identifiers", () => {
    expect(
      containsLocalPath('"/home/alex/project/file.ts"', "/home/alex/project"),
    ).toBe(true);
    expect(
      containsLocalPath('"/home/alex/project"', "/home/alex/project"),
    ).toBe(true);
    expect(
      containsLocalPath('"/home/alex/projector/file"', "/home/alex/project"),
    ).toBe(false);
    expect(containsLocalPath('"/application/api"', "/app")).toBe(false);
    expect(containsLocalPath('"/app/index.mjs"', "/app")).toBe(false);
    expect(containsLocalPath('"/src/file.ts"', "/src")).toBe(false);
    expect(containsLocalPath('"/root/log"', "/root")).toBe(false);
    expect(
      containsLocalPath(
        '"C:\\\\Users\\\\alice\\\\project\\\\file"',
        "C:\\Users\\alice\\project",
      ),
    ).toBe(true);
  });
});
