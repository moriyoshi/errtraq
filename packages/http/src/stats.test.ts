import type { StatsBucket, Timestamp } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { facetJson, periodWindow, storeRange, zeroFill } from "./stats.js";

const now = Date.UTC(2024, 2, 10, 12, 30, 0);
const bucket = (ms: number, count: number): StatsBucket => ({
  hour: new Date(ms).toISOString() as Timestamp,
  count,
});

describe("stats windows", () => {
  it("ends the 24h window with the hour that contains now", () => {
    const w = periodWindow("24h", now);
    expect(w).toEqual({
      period: "24h",
      start: Date.UTC(2024, 2, 9, 13) / 1000,
      step: 3600,
      points: 24,
    });
    expect(storeRange([w])).toEqual({
      from: "2024-03-09T13:00:00.000Z",
      to: "2024-03-10T13:00:00.000Z",
    });
  });
  it("ends the daily windows with the current UTC day", () => {
    expect(storeRange([periodWindow("14d", now)])).toEqual({
      from: "2024-02-26T00:00:00.000Z",
      to: "2024-03-11T00:00:00.000Z",
    });
    expect(
      storeRange([periodWindow("24h", now), periodWindow("30d", now)]),
    ).toEqual({
      from: "2024-02-10T00:00:00.000Z",
      to: "2024-03-11T00:00:00.000Z",
    });
  });
  it("keeps every range inside the store's 31-day limit", () => {
    const edge = Date.UTC(2024, 2, 10, 23, 59, 59, 999);
    const r = storeRange([
      periodWindow("24h", edge),
      periodWindow("30d", edge),
    ]);
    expect(Date.parse(r.to) - Date.parse(r.from)).toBeLessThanOrEqual(
      31 * 86_400_000,
    );
  });
});

describe("zeroFill", () => {
  it("returns every point, zero where there is no bucket", () => {
    const w = periodWindow("24h", now);
    const points = zeroFill([bucket(Date.UTC(2024, 2, 10, 12), 3)], w);
    expect(points).toHaveLength(24);
    expect(points.at(-1)).toEqual([Date.UTC(2024, 2, 10, 12) / 1000, 3]);
    expect(points.slice(0, -1).every(([, n]) => n === 0)).toBe(true);
    expect(points.map(([t]) => t)).toEqual(
      Array.from({ length: 24 }, (_, i) => w.start + i * 3600),
    );
  });
  it("sums hourly buckets into days and ignores buckets outside the window", () => {
    const w = periodWindow("14d", now);
    const points = zeroFill(
      [
        bucket(Date.UTC(2024, 2, 10, 1), 2),
        bucket(Date.UTC(2024, 2, 10, 23), 5),
        bucket(Date.UTC(2024, 2, 9, 0), 1),
        bucket(Date.UTC(2024, 1, 20), 9),
        bucket(Date.UTC(2024, 2, 11), 9),
      ],
      w,
    );
    expect(points).toHaveLength(14);
    expect(points.at(-1)).toEqual([Date.UTC(2024, 2, 10) / 1000, 7]);
    expect(points.at(-2)).toEqual([Date.UTC(2024, 2, 9) / 1000, 1]);
    expect(points.reduce((n, [, c]) => n + c, 0)).toBe(8);
  });
});

describe("facetJson", () => {
  it("uses Sentry's tag shape and tolerates a key without values", () => {
    expect(facetJson({ key: "os.name" })).toEqual({
      key: "os.name",
      name: "OS",
      totalValues: 0,
      uniqueValues: 0,
      topValues: [],
    });
    expect(
      facetJson({
        key: "level",
        totalValues: 1,
        totalCount: 4,
        topValues: [{ value: "error", count: 4 }],
      }).topValues,
    ).toEqual([{ key: "level", name: "error", value: "error", count: 4 }]);
  });
});
