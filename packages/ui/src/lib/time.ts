const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "3 hours ago" style text; an unparsable or missing timestamp renders as an em dash. */
export function relativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((then - now) / 1000);
  for (const [unit, size] of UNITS)
    if (Math.abs(seconds) >= size || unit === "second")
      return formatter.format(Math.trunc(seconds / size), unit);
  return "—";
}

export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString();
}

/** Breadcrumb timestamps are ISO strings or epoch seconds depending on the SDK. */
export function breadcrumbTime(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number")
    return new Date(value < 1e11 ? value * 1000 : value).toISOString();
  return absoluteTime(value);
}
