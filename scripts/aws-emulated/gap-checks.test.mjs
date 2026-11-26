import { describe, expect, it } from "vitest";
import {
  assertConditionalUpdateAtomic,
  assertPartialBatchSupport,
} from "./gap-checks.mjs";

describe("emulator fixes must keep holding", () => {
  it("requires exactly one conditional update winner per round and cleans its table", async () => {
    let deleted = false,
      seen = false;
    const atomic = {
      dynamo: async (action) => {
        if (action === "DeleteTable") deleted = true;
        if (action === "UpdateItem") {
          if (seen) throw new Error("ConditionalCheckFailedException");
          seen = true;
        }
        return {};
      },
    };
    await expect(
      assertConditionalUpdateAtomic(atomic, 1, 2),
    ).resolves.toBeUndefined();
    expect(deleted).toBe(true);
    deleted = false;
    const racy = {
      dynamo: async (action) => {
        if (action === "DeleteTable") deleted = true;
        return {};
      },
    };
    await expect(assertConditionalUpdateAtomic(racy, 1, 2)).rejects.toThrow(
      "exactly one winner",
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
