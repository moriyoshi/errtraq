import { InvalidCursorError } from "@errtraq/core/store";
import { describe, expect, it } from "vitest";
import {
  component,
  eventTimeSort,
  indexCursor,
  issueCountSort,
  issueTimeSort,
  partition,
  readIndexCursor,
  sortKey,
} from "./keys.js";

describe("DynamoDB key encoding", () => {
  it("frames components without collisions and sorts by UTF-8 bytes", () => {
    expect(partition("KEY", "a|b", "c")).not.toBe(partition("KEY", "a", "b|c"));
    expect(
      ["😀", "a", "é", "aa"].sort((a, b) =>
        component(a) < component(b) ? -1 : component(a) > component(b) ? 1 : 0,
      ),
    ).toEqual(["a", "aa", "é", "😀"]);
    expect(partition("EV", "1", "2")).toMatch(/^EV\|/);
  });
  it("rejects empty, invalid Unicode and overlong keys", () => {
    expect(() => component("")).toThrow();
    expect(() => component("\ud800")).toThrow();
    expect(() => partition("EV", "x".repeat(1024))).toThrow();
    expect(() => sortKey("x".repeat(512))).toThrow();
  });
  it("round trips examined keys and rejects cursors from another scope", () => {
    const examined = {
      PK: "p",
      SK: "s",
      indexPK: "g",
      indexSK: "last-examined",
    };
    const cursor = indexCursor("query-a", examined);
    expect(readIndexCursor("query-a", cursor)).toEqual(examined);
    expect(() => readIndexCursor("query-b", cursor)).toThrow(
      InvalidCursorError,
    );
  });
  it("encodes descending issue order and ascending event order with bytewise ties", () => {
    const earlier = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-02T00:00:00.000Z";
    expect(issueTimeSort(later, "z") < issueTimeSort(earlier, "a")).toBe(true);
    expect(issueTimeSort(later, "a") < issueTimeSort(later, "aa")).toBe(true);
    expect(issueCountSort(10, "z") < issueCountSort(9, "a")).toBe(true);
    expect(issueCountSort(10, "a") < issueCountSort(10, "é")).toBe(true);
    expect(eventTimeSort(earlier, "é") < eventTimeSort(later, "a")).toBe(true);
    expect(() => issueCountSort(Number.MAX_SAFE_INTEGER + 1, "a")).toThrow();
    expect(() => eventTimeSort("2026-01-01", "a")).toThrow();
  });
});
