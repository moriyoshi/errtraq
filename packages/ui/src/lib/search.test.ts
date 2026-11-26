import { describe, expect, it } from "vitest";
import { parseSearch, stringifySearch, validateIssueSearch } from "./search";

describe("validateIssueSearch", () => {
  it("drops defaults and unknown values", () => {
    expect(validateIssueSearch({ status: "unresolved", sort: "date" })).toEqual(
      {},
    );
    expect(validateIssueSearch({ status: "bogus", sort: 3, q: "  " })).toEqual(
      {},
    );
  });
  it("keeps valid non-default values", () => {
    expect(
      validateIssueSearch({ status: "resolved", sort: "freq", q: "timeout" }),
    ).toEqual({ status: "resolved", sort: "freq", q: "timeout" });
  });
});

describe("search params", () => {
  it("never decodes values as JSON", () => {
    const id = "12345678901234567890123456789012";
    expect(parseSearch(`?event=${id}`)).toEqual({ event: id });
    expect(parseSearch("")).toEqual({});
  });
  it("round-trips and omits empty values", () => {
    expect(stringifySearch({ event: "abc", q: undefined, s: "" })).toBe(
      "?event=abc",
    );
    expect(stringifySearch({})).toBe("");
    expect(parseSearch(stringifySearch({ q: "a b&c" }))).toEqual({
      q: "a b&c",
    });
  });
});
