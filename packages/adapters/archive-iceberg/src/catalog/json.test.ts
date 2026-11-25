import { describe, expect, it } from "vitest";
import {
  Long,
  longString,
  parseJsonPreservingLongs,
  stringifyWithLongs,
} from "./json.js";

describe("long-safe JSON", () => {
  it("quotes only integers beyond the safe range, outside strings", () => {
    const parsed = parseJsonPreservingLongs(
      '{"a":9007199254740991,"b":9007199254740992,"c":-9223372036854775808,"d":1.5e3,"e":"12345678901234567890","f":[9223372036854775807]}',
    );
    expect(parsed).toEqual({
      a: 9007199254740991,
      b: "9007199254740992",
      c: "-9223372036854775808",
      d: 1500,
      e: "12345678901234567890",
      f: ["9223372036854775807"],
    });
  });
  it("handles escaped quotes inside strings", () => {
    expect(
      parseJsonPreservingLongs('{"k":"a\\"12345678901234567890\\""}'),
    ).toEqual({
      k: 'a"12345678901234567890"',
    });
  });
  it("round-trips ids exactly", () => {
    const text = stringifyWithLongs({
      ids: [new Long("9223372036854775807"), new Long(5), new Long(3n)],
    });
    expect(text).toBe('{"ids":[9223372036854775807,5,3]}');
  });
  it("leaves string values that look like a marker untouched", () => {
    const text = stringifyWithLongs({
      properties: { a: "__long__5", b: "errtraq-long:7" },
      id: new Long(9),
    });
    expect(JSON.parse(text)).toEqual({
      properties: { a: "__long__5", b: "errtraq-long:7" },
      id: 9,
    });
  });
  it("rejects unsafe numbers and non-integers", () => {
    expect(() => new Long(2 ** 60)).toThrow(TypeError);
    expect(() => new Long("1.5")).toThrow(TypeError);
    expect(longString(42)).toBe("42");
  });
});
