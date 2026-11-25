import { describe, expect, it, vi } from "vitest";
import { loadGaps, skipped } from "./gaps.mjs";

describe("emulator exception inventory", () => {
  it("requires named documented exceptions and rejects undeclared exclusions", () => {
    const gaps = loadGaps();
    expect(Object.keys(gaps)).toHaveLength(5);
    expect(() => skipped(gaps, "unlisted")).toThrow("Undeclared");
  });
  it("maps each exclusion to its upstream issues and prints the links", () => {
    const gaps = loadGaps();
    const issues = {
      "lambda-vpc-readback": [62],
      "dynamodb-conditional-atomicity": [61],
      "sqs-fifo": [64, 65, 66],
      "tags-eventbridge": [67],
      "cloudwatch-alarm-readback": [68],
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const [id, numbers] of Object.entries(issues)) {
        const links = numbers.map(
          (n) => `https://github.com/moriyoshi/winterbaume/issues/${n}`,
        );
        expect(gaps[id].issues).toEqual(links);
        skipped(gaps, id);
        expect(log).toHaveBeenLastCalledWith(
          expect.stringContaining(links.join(", ")),
        );
      }
    } finally {
      log.mockRestore();
    }
  });
});
