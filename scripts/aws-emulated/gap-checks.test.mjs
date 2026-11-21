import { describe, expect, it } from "vitest";
import {
  assertPartialBatchSupport,
  checkConditionalUpdateGap,
} from "./gap-checks.mjs";

describe("emulator gaps must still reproduce", () => {
  it("requires the conditional update race to reproduce and cleans its table", async () => {
    let updates = 0;
    const broken = {
      dynamo: async (action) => {
        if (action === "UpdateItem") {
          updates++;
          return {};
        }
        return {};
      },
    };
    await expect(
      checkConditionalUpdateGap(broken, 1, 2),
    ).resolves.toBeUndefined();
    expect(updates).toBe(2);
    let deleted = false,
      seen = false;
    const fixed = {
      dynamo: async (action) => {
        if (action === "DeleteTable") deleted = true;
        if (action === "UpdateItem") {
          if (seen) throw new Error("ConditionalCheckFailedException");
          seen = true;
        }
        return {};
      },
    };
    await expect(checkConditionalUpdateGap(fixed, 1, 2)).rejects.toThrow(
      "no longer reproduces",
    );
    expect(deleted).toBe(true);
  });
  it("requires partial batch settings", () => {
    expect(() => assertPartialBatchSupport({})).toThrow();
    expect(() =>
      assertPartialBatchSupport({
        FunctionResponseTypes: ["ReportBatchItemFailures"],
      }),
    ).not.toThrow();
  });
});
