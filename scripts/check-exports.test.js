import { describe, expect, it } from "vitest";
import { checkExports, checkPublishConfig } from "./check-exports.mjs";

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

describe("publishConfig exports", () => {
  const exports = {
    ".": {
      development: "./src/index.ts",
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    },
  };
  const published = {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  };
  it("requires the exports minus development on public packages", () => {
    const manifest = { name: "@errtraq/example", exports };
    expect(checkPublishConfig(manifest)).toEqual([
      "@errtraq/example: missing publishConfig.exports",
    ]);
    expect(
      checkPublishConfig({
        ...manifest,
        publishConfig: { exports },
      }),
    ).toHaveLength(1);
    expect(
      checkPublishConfig({
        ...manifest,
        publishConfig: { exports: published },
      }),
    ).toEqual([]);
  });
  it("skips private packages and allows plain file exports", () => {
    expect(checkPublishConfig({ name: "x", private: true, exports })).toEqual(
      [],
    );
    expect(
      checkPublishConfig({
        name: "x",
        exports: { "./package.json": "./package.json" },
        publishConfig: { exports: { "./package.json": "./package.json" } },
      }),
    ).toEqual([]);
  });
});
