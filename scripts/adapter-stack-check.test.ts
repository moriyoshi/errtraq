import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { assertSafeStackImports } from "./adapter-stack-check.js";

describe("stack helper import restrictions", () => {
  it("allows core and zod, and rejects forbidden transitive package imports", async () => {
    await mkdir(resolve(".agents-workspace/tmp"), { recursive: true });
    const dir = await mkdtemp(
      resolve(".agents-workspace/tmp/stack-import-test-"),
    );
    try {
      const root = resolve(dir, "stack.ts");
      const child = resolve(dir, "child.ts");
      await writeFile(
        root,
        'import { z } from "zod"; import type { PortKind } from "@errtraq/core"; export * from "./child.js";',
      );
      await writeFile(child, "export const safe = true;");
      await expect(
        assertSafeStackImports(pathToFileURL(root)),
      ).resolves.toBeUndefined();
      for (const specifier of [
        "node:sqlite",
        "@errtraq/queue-memory",
        "@errtraq/core/internal",
      ]) {
        await writeFile(child, `import "${specifier}";`);
        await expect(
          assertSafeStackImports(pathToFileURL(root)),
        ).rejects.toThrow(`Forbidden stack package import: ${specifier}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects require(), import = require() and process access", async () => {
    await mkdir(resolve(".agents-workspace/tmp"), { recursive: true });
    const dir = await mkdtemp(
      resolve(".agents-workspace/tmp/stack-import-test-"),
    );
    try {
      const root = resolve(dir, "stack.ts");
      for (const [code, message] of [
        ['const fs = require("node:fs");', "require() in stack graph"],
        [
          'import fs = require("node:fs");',
          "import = require() in stack graph",
        ],
        ["export const e = globalThis.process.env;", "Node global process"],
        ["export const e = process.env;", "Node global process"],
      ] as const) {
        await writeFile(root, code);
        await expect(
          assertSafeStackImports(pathToFileURL(root)),
        ).rejects.toThrow(message);
      }
      await writeFile(root, "export const e = { process: 1 }.process;");
      await expect(
        assertSafeStackImports(pathToFileURL(root)),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
