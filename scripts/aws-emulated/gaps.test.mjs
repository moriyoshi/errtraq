import { describe, expect, it, vi } from "vitest";
import { loadGaps, skipped } from "./gaps.mjs";

describe("emulator exception inventory", () => {
  it("requires named documented exceptions and rejects undeclared exclusions", () => {
    const gaps = loadGaps();
    expect(Object.keys(gaps)).toHaveLength(11);
    expect(() => skipped(gaps, "unlisted")).toThrow("Undeclared");
  });
  it("maps each exclusion to its upstream issue and prints the link", () => {
    const gaps = loadGaps();
    const issues = {
      "s3-lifecycle": 41,
      "dynamodb-deletion-protection": 42,
      "dynamodb-sse": 43,
      "lambda-partial-batch": 45,
      "eventbridge-retry-dlq": 47,
      "s3-ownership-delete": 50,
      "tags-dynamodb": 51,
      "tags-iam": 52,
      "tags-s3": 53,
      "tags-lambda-mapping": 54,
    };
    expect(gaps["lambda-vpc-readback"].issue).toBeNull();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const [id, issue] of Object.entries(issues)) {
        expect(gaps[id].issue).toBe(
          `https://github.com/moriyoshi/winterbaume/issues/${issue}`,
        );
        skipped(gaps, id);
        expect(log).toHaveBeenLastCalledWith(
          expect.stringContaining(gaps[id].issue),
        );
      }
    } finally {
      log.mockRestore();
    }
  });
});
