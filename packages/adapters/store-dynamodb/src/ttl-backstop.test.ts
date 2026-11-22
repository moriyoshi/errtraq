import { describe, expect, it } from "vitest";
import { eventBackstopEpoch } from "./ttl-backstop.js";

describe("event TTL backstop calculation", () => {
  it("includes retention and grace, rounding fractional seconds later", () => {
    const received = "2025-01-01T00:00:00.001Z";
    expect(eventBackstopEpoch(received, 30, 7)).toBe(
      Math.ceil(Date.parse("2025-02-07T00:00:00.001Z") / 1000),
    );
  });
  it("rejects noncanonical timestamps and invalid or overflowing bounds", () => {
    for (const time of ["2025-01-01", "2025-02-30T00:00:00.000Z", "invalid"])
      expect(() => eventBackstopEpoch(time, 30, 7)).toThrow(RangeError);
    for (const [retention, grace] of [
      [0, 7],
      [1.5, 7],
      [30, -1],
      [30, 0.5],
      [Number.MAX_SAFE_INTEGER, 0],
    ])
      expect(() =>
        eventBackstopEpoch("2025-01-01T00:00:00.000Z", retention, grace),
      ).toThrow(RangeError);
  });
});
