import { describe, expect, it } from "vitest";
import type { EventId, ProjectId, Timestamp } from "./domain.js";
import { InvalidIdentifierError } from "./errors.js";
import {
  assertIdentifier,
  assertIndexedText,
  MAX_IDENTIFIER_LENGTH,
  MAX_INDEXED_TEXT_BYTES,
  truncateIndexedText,
} from "./identifier-limits.js";
import { normalizeEvent } from "./normalize.js";

describe("identifier limits", () => {
  it("bounds identifiers so a serialized two-part key fits 255 characters", () => {
    const longest = "a".repeat(MAX_IDENTIFIER_LENGTH);
    expect(() => assertIdentifier("id", longest)).not.toThrow();
    expect(JSON.stringify([longest, longest]).length).toBeLessThanOrEqual(255);
    for (const bad of ["a".repeat(101), "", "a b", 'a"', "a\\", "é", 1])
      expect(() => assertIdentifier("id", bad)).toThrow(InvalidIdentifierError);
  });
  it("bounds indexed text by UTF-8 bytes and allows absent values", () => {
    expect(() => assertIndexedText("t", undefined)).not.toThrow();
    expect(() => assertIndexedText("t", "x".repeat(255))).not.toThrow();
    expect(() => assertIndexedText("t", "あ".repeat(85))).not.toThrow();
    expect(() => assertIndexedText("t", "あ".repeat(86))).toThrow(
      InvalidIdentifierError,
    );
    expect(() => assertIndexedText("t", "x".repeat(256))).toThrow(
      InvalidIdentifierError,
    );
  });
  it("truncates on code point boundaries", () => {
    const value = `${"x".repeat(254)}\u{1F600}\u{1F600}`;
    const out = truncateIndexedText(value);
    expect(out).toBe("x".repeat(254));
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(
      MAX_INDEXED_TEXT_BYTES,
    );
    expect(truncateIndexedText("short")).toBe("short");
  });
  it("normalization truncates event values stores would reject", async () => {
    const long = "あ".repeat(300);
    const { event } = await normalizeEvent(
      "1" as ProjectId,
      "a".repeat(32) as EventId,
      "2024-01-01T00:00:00.000Z" as Timestamp,
      {
        release: long,
        environment: long,
        user: { id: long, email: long, username: long, ip_address: long },
      },
    );
    for (const value of [
      event.release,
      event.environment,
      event.user?.id,
      event.user?.email,
      event.user?.username,
      event.user?.ipAddress,
    ])
      expect(() => assertIndexedText("v", value)).not.toThrow();
    expect(event.release).toBe("あ".repeat(85));
  });
});
