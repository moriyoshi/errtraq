import { describe, expect, it } from "vitest";
import { assertItemSize, s } from "./repository-base.js";

describe("DynamoDB item size", () => {
  it("counts UTF-8 attribute names and values at the 400 KiB limit", () => {
    expect(() => assertItemSize({ x: s("a".repeat(409599)) })).not.toThrow();
    expect(() => assertItemSize({ x: s("a".repeat(409600)) })).toThrow(
      RangeError,
    );
    expect(() => assertItemSize({ x: s("é".repeat(204800)) })).toThrow(
      RangeError,
    );
  });
});
