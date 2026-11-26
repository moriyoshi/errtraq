/**
 * Pure helpers for the statistics charts: no JSX, no DOM, so they are unit-tested directly.
 * A series is Sentry's `[unixSeconds, count]` points, ascending by time.
 */
export type Point = readonly [number, number];

/**
 * Evenly spaced, zero-filled points from `first` to `last` at `step` seconds. The API already
 * zero-fills; this keeps the charts honest against a server that omits empty buckets, and
 * merges duplicate timestamps. Points off the step grid are snapped down onto it.
 */
export function fillSeries(
  points: readonly Point[],
  step: number,
  window?: { start: number; count: number },
): Point[] {
  if (!(step > 0)) throw new RangeError("step must be positive");
  const cells = new Map<number, number>();
  for (const [time, count] of points) {
    if (!Number.isFinite(time) || !Number.isFinite(count)) continue;
    const key = Math.floor(time / step) * step;
    cells.set(key, (cells.get(key) ?? 0) + Math.max(0, count));
  }
  const keys = [...cells.keys()];
  const start = window
    ? Math.floor(window.start / step) * step
    : keys.length
      ? Math.min(...keys)
      : undefined;
  const count = window
    ? window.count
    : keys.length
      ? (Math.max(...keys) - (start as number)) / step + 1
      : 0;
  if (start === undefined) return [];
  return Array.from({ length: count }, (_, i): Point => {
    const time = start + i * step;
    return [time, cells.get(time) ?? 0];
  });
}

export const total = (points: readonly Point[]): number =>
  points.reduce((sum, [, count]) => sum + count, 0);
export const peak = (points: readonly Point[]): number =>
  points.reduce((max, [, count]) => Math.max(max, count), 0);

export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
  time: number;
  count: number;
}

/**
 * Bar rectangles inside a `width` x `height` box. Heights scale linearly to the peak, a
 * non-zero count is at least `minHeight` tall (so one event stays visible next to a large
 * peak), and a zero count has height 0. `gap` is the space between bars.
 */
export function bars(
  points: readonly Point[],
  width: number,
  height: number,
  options: { gap?: number; minHeight?: number } = {},
): Bar[] {
  const gap = options.gap ?? 1;
  const minHeight = options.minHeight ?? 1;
  if (!points.length) return [];
  const slot = width / points.length;
  const barWidth = Math.max(slot - gap, 0.5);
  const max = peak(points);
  return points.map(([time, count], i) => {
    const h =
      count <= 0 || max <= 0
        ? 0
        : Math.min(height, Math.max(minHeight, (count / max) * height));
    return {
      x: i * slot + (slot - barWidth) / 2,
      y: height - h,
      width: barWidth,
      height: h,
      time,
      count,
    };
  });
}

/** SVG `points` attribute of a polyline through the series, scaled to the box. */
export function sparklinePoints(
  points: readonly Point[],
  width: number,
  height: number,
  padding = 1,
): string {
  if (points.length === 0) return "";
  const max = peak(points);
  const inner = height - 2 * padding;
  return points
    .map(([, count], i) => {
      const x =
        points.length === 1 ? width / 2 : (i / (points.length - 1)) * width;
      const y =
        max <= 0 ? height - padding : padding + inner * (1 - count / max);
      return `${round(x)},${round(y)}`;
    })
    .join(" ");
}
const round = (n: number) => Math.round(n * 100) / 100;

/** Share of `part` in `whole` as a percentage clamped to 0..100; 0 when there is no whole. */
export function percent(part: number, whole: number): number {
  if (!(whole > 0) || !(part > 0)) return 0;
  return Math.min(100, (part / whole) * 100);
}

/** Percent text, `<1%` for a non-zero share that would round to zero. */
export function percentLabel(part: number, whole: number): string {
  const value = percent(part, whole);
  if (value === 0) return "0%";
  return value < 1 ? "<1%" : `${Math.round(value)}%`;
}
