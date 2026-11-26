import { describe, expect, it } from "vitest";
import { loadGaps, skipped } from "./gaps.mjs";

describe("emulator exception inventory", () => {
  it("is empty at v0.2.10 and rejects undeclared exclusions", () => {
    const gaps = loadGaps();
    expect(Object.keys(gaps)).toHaveLength(0);
    expect(() => skipped(gaps, "unlisted")).toThrow("Undeclared");
  });
});
