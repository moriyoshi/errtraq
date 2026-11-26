// Runtime-only store utilities; this entry does not import stack schemas.

export {
  decodeCursor,
  encodeCursor,
  eventCursorScope,
  pageLimit,
} from "./cursor.js";
export { summarizeApiToken } from "./domain.js";
export {
  ConflictError,
  InvalidCursorError,
  InvalidIdentifierError,
  NotFoundError,
  UnsupportedQueryError,
  VersionConflictError,
} from "./errors.js";
export {
  assertIdentifier,
  assertIndexedText,
  withIdentifierLimits,
} from "./identifier-limits.js";
export { bundleDebugIdsDigest } from "./ids.js";
export {
  assertFacetKey,
  assertFacetLimit,
  assertStatsRange,
  DAY_MS,
  FACET_KEYS,
  type FacetKey,
  facetsOf,
  HOUR_MS,
  hourStart,
  isFacetKey,
  MAX_FACET_TOP_VALUES,
  MAX_FACET_VALUE_CHARS,
  MAX_STATS_ISSUES,
  STATS_RETENTION_DAYS,
  type StatsIncrements,
  statsCutoff,
  statsIncrements,
} from "./stats.js";
