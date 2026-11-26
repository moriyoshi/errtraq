import { describe, expect, it } from "vitest";
import {
  bars,
  fillSeries,
  peak,
  percent,
  percentLabel,
  sparklinePoints,
  total,
} from "./series";

const H = 3600;

describe("fillSeries", () => {
  it("zero-fills gaps between the first and last point", () => {
    expect(
      fillSeries(
        [
          [0, 2],
          [3 * H, 1],
        ],
        H,
      ),
    ).toEqual([
      [0, 2],
      [H, 0],
      [2 * H, 0],
      [3 * H, 1],
    ]);
  });
  it("fills a fixed window, ignoring points outside it and merging duplicates", () => {
    const out = fillSeries(
      [
        [H + 5, 1],
        [H + 9, 2],
        [99 * H, 7],
      ],
      H,
      { start: 0, count: 3 },
    );
    expect(out).toEqual([
      [0, 0],
      [H, 3],
      [2 * H, 0],
    ]);
  });
  it("handles empty input and rejects a bad step", () => {
    expect(fillSeries([], H)).toEqual([]);
    expect(fillSeries([], H, { start: 0, count: 2 })).toEqual([
      [0, 0],
      [H, 0],
    ]);
    expect(() => fillSeries([], 0)).toThrow(RangeError);
  });
  it("drops non-finite values and clamps negative counts", () => {
    expect(
      fillSeries(
        [
          [0, Number.NaN],
          [H, -4],
        ],
        H,
      ),
    ).toEqual([[H, 0]]);
  });
});

describe("totals", () => {
  it("sums and finds the peak", () => {
    const points = [
      [0, 1],
      [H, 5],
      [2 * H, 2],
    ] as const;
    expect(total(points)).toBe(8);
    expect(peak(points)).toBe(5);
    expect(peak([])).toBe(0);
  });
});

describe("bars", () => {
  it("scales to the peak and keeps one event visible", () => {
    const out = bars(
      [
        [0, 0],
        [H, 1],
        [2 * H, 100],
      ],
      30,
      50,
      { gap: 2, minHeight: 2 },
    );
    expect(out.map((b) => b.height)).toEqual([0, 2, 50]);
    expect(out.map((b) => b.y)).toEqual([50, 48, 0]);
    expect(out[0]?.width).toBe(8);
    expect(out[1]?.x).toBeCloseTo(11);
    for (const bar of out) expect(bar.x + bar.width).toBeLessThanOrEqual(30);
  });
  it("draws nothing tall for an all-zero series", () => {
    const out = bars(
      [
        [0, 0],
        [H, 0],
      ],
      10,
      10,
    );
    expect(out.every((b) => b.height === 0)).toBe(true);
    expect(bars([], 10, 10)).toEqual([]);
  });
});

describe("sparklinePoints", () => {
  it("maps the peak to the top and zero to the bottom within padding", () => {
    expect(
      sparklinePoints(
        [
          [0, 0],
          [H, 10],
          [2 * H, 5],
        ],
        100,
        20,
        1,
      ),
    ).toBe("0,19 50,1 100,10");
  });
  it("lies flat on the baseline for zeros and centres a single point", () => {
    expect(
      sparklinePoints(
        [
          [0, 0],
          [H, 0],
        ],
        10,
        10,
        1,
      ),
    ).toBe("0,9 10,9");
    expect(sparklinePoints([[0, 3]], 10, 10, 1)).toBe("5,1");
    expect(sparklinePoints([], 10, 10)).toBe("");
  });
});

describe("percent", () => {
  it("clamps and labels small shares", () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(5, 4)).toBe(100);
    expect(percent(1, 0)).toBe(0);
    expect(percentLabel(1, 1000)).toBe("<1%");
    expect(percentLabel(0, 10)).toBe("0%");
    expect(percentLabel(1, 3)).toBe("33%");
  });
});
