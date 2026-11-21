import { describe, expect, it } from "vitest";
import { loadGaps, skipped } from "./gaps.mjs";

describe("emulator exception inventory", () => {
  it("requires named documented exceptions and rejects undeclared exclusions", () => {
    const gaps = loadGaps();
    expect(Object.keys(gaps)).toHaveLength(10);
    expect(() => skipped(gaps, "unlisted")).toThrow("Undeclared");
  });
});
