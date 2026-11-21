import { InvalidCursorError } from "@errtraq/core/store";
import { describe, expect, it } from "vitest";
import {
  component,
  indexCursor,
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
});
