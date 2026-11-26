import { describe, expect, it } from "vitest";
import { breadcrumbTime, relativeTime } from "./time";

const now = Date.parse("2024-06-01T12:00:00.000Z");

describe("relativeTime", () => {
  it("formats past times in the largest fitting unit", () => {
    expect(relativeTime("2024-06-01T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(relativeTime("2024-05-30T12:00:00.000Z", now)).toBe("2 days ago");
    expect(relativeTime("2024-06-01T11:59:30.000Z", now)).toBe(
      "30 seconds ago",
    );
  });
  it("renders missing or invalid values as a dash", () => {
    expect(relativeTime(null)).toBe("—");
    expect(relativeTime("nope")).toBe("—");
  });
});

describe("breadcrumbTime", () => {
  it("accepts epoch seconds, epoch milliseconds and ISO text", () => {
    expect(breadcrumbTime(1717243200)).toBe("2024-06-01T12:00:00.000Z");
    expect(breadcrumbTime(1717243200000)).toBe("2024-06-01T12:00:00.000Z");
    expect(breadcrumbTime("2024-06-01T12:00:00Z")).toBe(
      "2024-06-01T12:00:00.000Z",
    );
    expect(breadcrumbTime(undefined)).toBe("");
  });
});
