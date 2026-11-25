import { selections } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import local from "../../../stacks/local.js";
import localArchive from "../../../stacks/local-archive.js";
import { archiveBindings, hasEnsureTable } from "./archive-engine.js";

describe("archive engine binding", () => {
  it("supplies the DuckDB engine to archive-iceberg only", async () => {
    const archive = selections(localArchive).get("archive");
    if (!archive) throw new Error("archive selection missing");
    const bindings = await archiveBindings(archive);
    expect(typeof bindings.createEngine).toBe("function");
    for (const [, selection] of selections(local))
      expect(await archiveBindings(selection)).toEqual({});
  });
  it("recognizes a store that can create its table", () => {
    expect(
      hasEnsureTable({ ensureTable: async () => ({ created: true }) }),
    ).toBe(true);
    expect(hasEnsureTable({})).toBe(false);
    expect(hasEnsureTable(null)).toBe(false);
  });
});
