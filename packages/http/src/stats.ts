import type {
  FacetKey,
  FacetSummary,
  StatsBucket,
  Timestamp,
} from "@moriyoshi/errtraq-core/runtime";

const HOUR_S = 3600;
const DAY_S = 86_400;

/** Sentry's `[unixSeconds, count]` point. */
export type StatPoint = [number, number];
export type StatsPeriod = "24h" | "14d" | "30d";

const PERIODS: Record<StatsPeriod, { unit: "hour" | "day"; points: number }> = {
  "24h": { unit: "hour", points: 24 },
  "14d": { unit: "day", points: 14 },
  "30d": { unit: "day", points: 30 },
};

/** The list accepts 24h and 14d (the detail also renders 30d); anything else is a 400. */
export const LIST_STATS_PERIODS = ["24h", "14d"] as const;

export interface PeriodWindow {
  period: StatsPeriod;
  /** Start of the first point, unix seconds. */
  start: number;
  /** Seconds per point. */
  step: number;
  points: number;
}

/**
 * The window of one period ending with the point that contains `now`: the last 24 UTC hours, or
 * the last 14 or 30 UTC days (the current, partial hour or day is the last point).
 */
export function periodWindow(period: StatsPeriod, nowMs: number): PeriodWindow {
  const { unit, points } = PERIODS[period];
  const step = unit === "hour" ? HOUR_S : DAY_S;
  const current = Math.floor(nowMs / 1000 / step) * step;
  return { period, start: current - (points - 1) * step, step, points };
}

const iso = (seconds: number) =>
  new Date(seconds * 1000).toISOString() as Timestamp;
/** The half-open store range that covers every window. */
export function storeRange(windows: readonly PeriodWindow[]): {
  from: Timestamp;
  to: Timestamp;
} {
  const from = Math.min(...windows.map((w) => w.start));
  const to = Math.max(...windows.map((w) => w.start + w.points * w.step));
  return { from: iso(from), to: iso(to) };
}

/**
 * Zero-filled `[unixSeconds, count]` points for one window: hourly buckets are summed into the
 * window's points, buckets outside it are ignored, and every point is present even with no data.
 */
export function zeroFill(
  buckets: readonly StatsBucket[],
  window: PeriodWindow,
): StatPoint[] {
  const out: StatPoint[] = Array.from({ length: window.points }, (_, i) => [
    window.start + i * window.step,
    0,
  ]);
  for (const bucket of buckets) {
    const seconds = Math.floor(Date.parse(bucket.hour) / 1000);
    const index = Math.floor((seconds - window.start) / window.step);
    const point = out[index];
    if (index >= 0 && point && seconds >= window.start)
      point[1] += bucket.count;
  }
  return out;
}

const NAMES: Record<FacetKey, string> = {
  level: "Level",
  environment: "Environment",
  release: "Release",
  server_name: "Server",
  "browser.name": "Browser",
  "os.name": "OS",
  "runtime.name": "Runtime",
};

/**
 * Sentry's tag facet shape for one key. As in Sentry, `totalValues` is the number of events that
 * carry the key (the sum of its value counts, so a UI can draw proportions); errtraq adds
 * `uniqueValues`, the number of distinct values.
 */
export function facetJson(
  summary: Pick<FacetSummary, "key"> & Partial<FacetSummary>,
) {
  return {
    key: summary.key,
    name: NAMES[summary.key],
    totalValues: summary.totalCount ?? 0,
    uniqueValues: summary.totalValues ?? 0,
    topValues: (summary.topValues ?? []).map((v) => ({
      key: summary.key,
      name: v.value,
      value: v.value,
      count: v.count,
    })),
  };
}
export const tagValueJson = (
  key: FacetKey,
  v: { value: string; count: number },
) => ({
  key,
  name: v.value,
  value: v.value,
  count: v.count,
});
