import { describe, expect, it } from "vitest";
import { nextCursor, parseLinkHeader } from "./link";

const header = (nextResults: string, cursor = "0:100:0") =>
  `<https://x/api/0/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://x/api/0/issues/?cursor=${cursor}>; rel="next"; results="${nextResults}"; cursor="${cursor}"`;

describe("parseLinkHeader", () => {
  it("reads both relations with their results flags", () => {
    expect(parseLinkHeader(header("true"))).toEqual({
      previous: { cursor: "0:0:1", results: false },
      next: { cursor: "0:100:0", results: true },
    });
  });
  it("tolerates a missing header, unknown relations and missing cursors", () => {
    expect(parseLinkHeader(null)).toEqual({ previous: null, next: null });
    expect(parseLinkHeader('<u>; rel="first"; cursor="x"').next).toBeNull();
    expect(parseLinkHeader('<u>; rel="next"; results="true"').next).toBeNull();
  });
  it("handles commas inside URLs", () => {
    const parsed = parseLinkHeader(
      '<https://x/?q=a,b>; rel="next"; results="true"; cursor="c1"',
    );
    expect(parsed.next).toEqual({ cursor: "c1", results: true });
  });
});

describe("nextCursor", () => {
  it("follows results=true", () => {
    expect(nextCursor(header("true"))).toBe("0:100:0");
  });
  it("stops at results=false even when a cursor is present", () => {
    expect(nextCursor(header("false"))).toBeUndefined();
  });
  it("is undefined without a header", () => {
    expect(nextCursor(undefined)).toBeUndefined();
  });
});
