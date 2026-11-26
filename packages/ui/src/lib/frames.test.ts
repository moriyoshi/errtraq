import { describe, expect, it } from "vitest";
import type { Frame } from "../api/entries";
import { contextLines, frameLocation, prepareFrames } from "./frames";

const f = (name: string, in_app?: boolean): Frame => ({
  filename: name,
  in_app,
});

describe("prepareFrames", () => {
  it("lists the most recent call first", () => {
    const items = prepareFrames([f("a", true), f("b", true)]);
    expect(
      items.map((i) => (i.kind === "frame" ? i.frame.filename : "?")),
    ).toEqual(["b", "a"]);
  });

  it("folds runs of non-in-app frames", () => {
    // oldest first: app, lib, lib, app, lib
    const items = prepareFrames([
      f("a", true),
      f("l1", false),
      f("l2"),
      f("b", true),
      f("l3", false),
    ]);
    expect(items.map((i) => i.kind)).toEqual([
      "frame",
      "frame",
      "collapsed",
      "frame",
    ]);
    const run = items[2];
    expect(
      run?.kind === "collapsed" && run.frames.map((x) => x.frame.filename),
    ).toEqual(["l2", "l1"]);
  });

  it("keeps a lone library frame visible", () => {
    const items = prepareFrames([f("a", true), f("l", false), f("b", true)]);
    expect(items.map((i) => i.kind)).toEqual(["frame", "frame", "frame"]);
  });

  it("shows everything when no frame is in-app or when asked", () => {
    expect(
      prepareFrames([f("x"), f("y", false), f("z", false)]).every(
        (i) => i.kind === "frame",
      ),
    ).toBe(true);
    expect(
      prepareFrames(
        [f("a", true), f("l1", false), f("l2", false), f("b", true)],
        true,
      ).every((i) => i.kind === "frame"),
    ).toBe(true);
  });

  it("handles empty input", () => {
    expect(prepareFrames([])).toEqual([]);
  });

  it("keeps original indexes", () => {
    const items = prepareFrames([f("a", true), f("b", true)]);
    expect(items.map((i) => (i.kind === "frame" ? i.index : -1))).toEqual([
      1, 0,
    ]);
  });
});

describe("contextLines", () => {
  it("numbers lines around the failing one and marks it", () => {
    const lines = contextLines({
      lineno: 10,
      context_line: "boom()",
      pre_context: ["a", "b"],
      post_context: ["c"],
    });
    expect(lines.map((l) => [l.lineno, l.text, l.current])).toEqual([
      [8, "a", false],
      [9, "b", false],
      [10, "boom()", true],
      [11, "c", false],
    ]);
  });

  it("omits numbers without lineno and returns nothing without a context line", () => {
    expect(
      contextLines({ context_line: "x", pre_context: ["w"] }).map(
        (l) => l.lineno,
      ),
    ).toEqual([null, null]);
    expect(contextLines({ pre_context: ["w"] })).toEqual([]);
  });
});

describe("frameLocation", () => {
  it("joins file, line and column", () => {
    expect(frameLocation({ filename: "a.js", lineno: 3, colno: 7 })).toBe(
      "a.js:3:7",
    );
    expect(frameLocation({ abs_path: "/x.js" })).toBe("/x.js");
    expect(frameLocation({})).toBe("(unknown)");
  });
});
