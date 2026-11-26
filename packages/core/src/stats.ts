import type { ProjectId, StoredEvent, Timestamp } from "./domain.js";
import { toTimestamp } from "./domain.js";
import { truncateIndexedText } from "./identifier-limits.js";
import type { ActiveStore } from "./ports.js";

/**
 * Per-issue statistics maintained inside the atomic record operation (UI-d).
 *
 * Counters have the meaning of `Issue.count`: accepted insertions ever recorded, never
 * decremented by retention, archival or erasure. A duplicate event changes no counter.
 * The time basis is `receivedAt` (client clocks drift; late events must not rewrite old buckets).
 */

/**
 * The only tag keys that are counted. A fixed allow-list keeps facets free of personal data:
 * facets are not reached by subject erasure, so `user.*`, URLs, IPs and every other key are
 * never counted. `level`, `environment` and `release` come from the stored event's fields; the
 * rest come from an explicit event tag of that name (the normalizer does not derive them from
 * contexts, so a client that sends no such tag simply has no facet for the key).
 */
export const FACET_KEYS = [
  "level",
  "environment",
  "release",
  "server_name",
  "browser.name",
  "os.name",
  "runtime.name",
] as const;
export type FacetKey = (typeof FACET_KEYS)[number];
export const isFacetKey = (value: string): value is FacetKey =>
  (FACET_KEYS as readonly string[]).includes(value);

/** Facet values are truncated to this many characters (then to the indexed-text byte bound). */
export const MAX_FACET_VALUE_CHARS = 200;
/** Hourly buckets older than this many days are removed. */
export const STATS_RETENTION_DAYS = 31;
/** `series` accepts at most this many issues and at most STATS_RETENTION_DAYS of range. */
export const MAX_STATS_ISSUES = 100;
export const MAX_FACET_TOP_VALUES = 10;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Start of the UTC hour containing the timestamp. */
export function hourStart(value: string): Timestamp {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new RangeError("Invalid timestamp");
  return toTimestamp(new Date(millis - (millis % HOUR_MS)));
}

function clipValue(value: string): string {
  const chars = Array.from(value);
  return truncateIndexedText(
    chars.length > MAX_FACET_VALUE_CHARS
      ? chars.slice(0, MAX_FACET_VALUE_CHARS).join("")
      : value,
  );
}

/** The allow-listed (key, value) pairs of one event, at most one per key. */
export function facetsOf(
  event: Pick<StoredEvent, "level" | "release" | "environment" | "tags">,
): Array<{ key: FacetKey; value: string }> {
  const out: Array<{ key: FacetKey; value: string }> = [];
  for (const key of FACET_KEYS) {
    const raw =
      key === "level"
        ? event.level
        : key === "environment"
          ? event.environment
          : key === "release"
            ? event.release
            : Object.hasOwn(event.tags, key)
              ? event.tags[key]
              : undefined;
    if (typeof raw !== "string" || raw === "") continue;
    const value = clipValue(raw);
    if (value !== "") out.push({ key, value });
  }
  return out;
}

export interface StatsIncrements {
  /** One entry per distinct UTC hour, ascending. */
  hours: Array<{ hour: Timestamp; count: number }>;
  /** One entry per distinct (key, value), in allow-list then value order. */
  facets: Array<{ key: FacetKey; value: string; count: number }>;
}

/**
 * Aggregate the increments of newly inserted events: one update per distinct bucket and per
 * distinct tag value, never one per record. Adapters call this with the events that were
 * actually inserted (duplicates excluded).
 */
export function statsIncrements(
  events: readonly Pick<
    StoredEvent,
    "receivedAt" | "level" | "release" | "environment" | "tags"
  >[],
): StatsIncrements {
  const hours = new Map<Timestamp, number>();
  const facets = new Map<
    string,
    { key: FacetKey; value: string; count: number }
  >();
  for (const event of events) {
    const hour = hourStart(event.receivedAt);
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
    for (const { key, value } of facetsOf(event)) {
      const id = JSON.stringify([key, value]);
      const entry = facets.get(id);
      if (entry) entry.count++;
      else facets.set(id, { key, value, count: 1 });
    }
  }
  const byte = (a: string, b: string) => {
    const x = new TextEncoder().encode(a),
      y = new TextEncoder().encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++)
      if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
    return x.length - y.length;
  };
  return {
    hours: [...hours]
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => byte(a.hour, b.hour)),
    facets: [...facets.values()].sort(
      (a, b) =>
        FACET_KEYS.indexOf(a.key) - FACET_KEYS.indexOf(b.key) ||
        byte(a.value, b.value),
    ),
  };
}

/** Validate the arguments of `IssueStatsRepo.series`; every adapter shares one rule. */
export function assertStatsRange(
  issueIds: readonly string[],
  range: { from: string; to: string },
): void {
  if (!Array.isArray(issueIds))
    throw new TypeError("issueIds must be an array");
  if (issueIds.length > MAX_STATS_ISSUES)
    throw new RangeError(`At most ${MAX_STATS_ISSUES} issues per call`);
  const from = Date.parse(range.from),
    to = Date.parse(range.to);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    toTimestamp(new Date(from)) !== range.from ||
    toTimestamp(new Date(to)) !== range.to
  )
    throw new RangeError("Range bounds must be canonical timestamps");
  if (to < from) throw new RangeError("Range end precedes its start");
  if (to - from > STATS_RETENTION_DAYS * DAY_MS)
    throw new RangeError(`Range exceeds ${STATS_RETENTION_DAYS} days`);
}

/** Validate the `limit` of `tagFacets` (1..10). */
export function assertFacetLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FACET_TOP_VALUES)
    throw new RangeError(`limit must be 1..${MAX_FACET_TOP_VALUES}`);
}

export function assertFacetKey(key: string): asserts key is FacetKey {
  if (!isFacetKey(key)) throw new RangeError("Tag key is not allow-listed");
}

/** First hour start that is still kept at `now`. */
export function statsCutoff(now: string): Timestamp {
  return hourStart(
    toTimestamp(new Date(Date.parse(now) - STATS_RETENTION_DAYS * DAY_MS)),
  );
}

/**
 * Retention-cron path: remove one project's hourly buckets older than the 31-day window. A
 * TTL store also expires them by itself; calling this is always safe. Bounded: the caller
 * re-runs while `hasMore`.
 */
export async function deleteExpiredStats(options: {
  store: Pick<ActiveStore, "stats">;
  projectId: ProjectId;
  now: Timestamp;
  maxBuckets?: number;
}): Promise<{ deleted: number; hasMore: boolean }> {
  const repo = options.store.stats;
  if (!repo) return { deleted: 0, hasMore: false };
  const cutoff = statsCutoff(options.now);
  const budget = options.maxBuckets ?? 5_000;
  let deleted = 0;
  for (;;) {
    const result = await repo.deleteBefore(options.projectId, cutoff, {
      limit: Math.min(500, budget - deleted),
    });
    deleted += result.deleted;
    if (!result.hasMore) return { deleted, hasMore: false };
    if (deleted >= budget || result.deleted === 0)
      return { deleted, hasMore: true };
  }
}
