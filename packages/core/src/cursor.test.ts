import { describe, expect, it } from "vitest";
import { encodeCursor } from "./cursor.js";
import { InvalidCursorError } from "./errors.js";

describe("cursor encoding", () => {
  it("rejects cursors that its decoder cannot accept", () => {
    expect(() => encodeCursor("scope", ["x".repeat(8192)])).toThrow(
      InvalidCursorError,
    );
  });
});
