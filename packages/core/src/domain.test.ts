import { describe, expect, it } from "vitest";
import {
  isProjectId,
  isTimestamp,
  parseTimestamp,
  toTimestamp,
} from "./domain.js";

describe("domain validation", () => {
  it("accepts only canonical UTC millisecond timestamps", () => {
    const value = "2024-01-01T00:00:00.000Z";
    expect(isTimestamp(value)).toBe(true);
    expect(parseTimestamp(value)).toBe(value);
    expect(toTimestamp(new Date(value))).toBe(value);
    for (const invalid of [
      "2024-01-01T00:00:00Z",
      "2024-02-31T00:00:00.000Z",
      "2024-01-01T00:00:00.000+00:00",
    ]) {
      expect(isTimestamp(invalid)).toBe(false);
      expect(() => parseTimestamp(invalid)).toThrow();
    }
  });
  it("accepts decimal project IDs only", () => {
    expect(isProjectId("123")).toBe(true);
    for (const value of ["", "-1", "x1", "1.2"])
      expect(isProjectId(value)).toBe(false);
  });
});
