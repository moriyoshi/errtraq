import { describe, expect, it } from "vitest";
import { type KeyEventLike, moveFocus, shortcutFor } from "./shortcuts";

const key = (k: string, extra: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  target: { tagName: "BODY" },
  ...extra,
});

describe("shortcutFor", () => {
  it("maps the documented keys", () => {
    const map: Record<string, string> = {
      j: "next",
      k: "previous",
      Enter: "open",
      o: "open",
      x: "toggleSelect",
      r: "resolve",
      i: "ignore",
      u: "unresolve",
      "/": "search",
      "[": "previousEvent",
      "]": "nextEvent",
      "?": "help",
    };
    for (const [k, action] of Object.entries(map))
      expect(shortcutFor(key(k))).toBe(action);
  });

  it("ignores other keys, including inherited property names and shifted letters", () => {
    for (const k of ["a", "J", "Escape", " ", "constructor", "toString"])
      expect(shortcutFor(key(k))).toBeNull();
  });

  it("is ignored while typing in an input, textarea, select or contenteditable", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"])
      expect(shortcutFor(key("j", { target: { tagName } }))).toBeNull();
    expect(
      shortcutFor(
        key("j", { target: { tagName: "DIV", isContentEditable: true } }),
      ),
    ).toBeNull();
  });

  it("is ignored with Ctrl, Meta or Alt held, but not for Shift-typed `?`", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const)
      expect(shortcutFor(key("r", { [mod]: true }))).toBeNull();
    expect(shortcutFor(key("?"))).toBe("help");
  });

  it("leaves Enter to a focused link, button or summary", () => {
    for (const tagName of ["A", "BUTTON", "SUMMARY"]) {
      expect(shortcutFor(key("Enter", { target: { tagName } }))).toBeNull();
      // Other keys still work with a link focused (j after clicking a row link).
      expect(shortcutFor(key("j", { target: { tagName } }))).toBe("next");
    }
    expect(shortcutFor(key("Enter", { target: { tagName: "LI" } }))).toBe(
      "open",
    );
  });

  it("skips handled events and IME composition", () => {
    expect(shortcutFor(key("j", { defaultPrevented: true }))).toBeNull();
    expect(shortcutFor(key("j", { isComposing: true }))).toBeNull();
    expect(shortcutFor(key("j", { target: null }))).toBe("next");
  });
});

describe("moveFocus", () => {
  it("starts at the first row and clamps at both ends", () => {
    expect(moveFocus(-1, 3, "next")).toBe(0);
    expect(moveFocus(-1, 3, "previous")).toBe(0);
    expect(moveFocus(0, 3, "next")).toBe(1);
    expect(moveFocus(2, 3, "next")).toBe(2);
    expect(moveFocus(0, 3, "previous")).toBe(0);
    expect(moveFocus(2, 3, "previous")).toBe(1);
  });
  it("answers -1 for an empty list and resets a stale index", () => {
    expect(moveFocus(0, 0, "next")).toBe(-1);
    expect(moveFocus(9, 3, "next")).toBe(0);
  });
});
