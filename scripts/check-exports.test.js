import { describe, expect, it } from "vitest";
import { checkExports } from "./check-exports.mjs";

describe("workspace source exports", () => {
  it("requires a development source and matching typecheck path on every subpath", () => {
    const manifest = {
      name: "@errtraq/example",
      exports: {
        ".": { development: "./src/index.ts" },
        "./stack": { types: "./dist/stack.d.ts" },
      },
    };
    expect(
      checkExports(manifest, "packages/example", {
        "@errtraq/example": ["packages/example/src/index.ts"],
      }),
    ).toEqual(["@errtraq/example/stack: missing development source export"]);
    manifest.exports["./stack"].development = "./src/stack.ts";
    expect(checkExports(manifest, "packages/example", {})).toHaveLength(2);
    expect(
      checkExports(manifest, "packages/example", {
        "@errtraq/example": ["packages/example/src/index.ts"],
        "@errtraq/example/stack": ["packages/example/src/stack.ts"],
      }),
    ).toEqual([]);
  });
});
