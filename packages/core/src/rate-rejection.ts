import type { ProjectId, ProjectRateLimits, Timestamp } from "./domain.js";
import type { KV, Logger, ProjectRepo } from "./ports.js";

/**
 * Stage 3 rate-based rejection (see SUBJECT_INDEX_DESIGN.md "Rate-based rejection").
 * Both limits are disabled unless configured. Counters are fixed-window `KV.increment`
 * values. Charging is exact under retries and redelivery: the KV has no put-if-absent, so an
 * `increment` that returns 1 on a per-event (per-issue for the new-issue cap) marker key is the
 * atomic "first attempt" signal. Only the first attempt charges the counter and stores its
 * decision under an outcome key; later attempts reuse that decision without charging. A crash
 * after the counter is charged but before the outcome is stored makes the next attempt admit
 * once uncharged, and a crash can still lose a dropped-counter increment.
 */
export interface RateRejectionConfig {
  /** Per-issue fixed-window event limit. */
  issueRateLimit?: { events: number; windowSec: number };
  /** Per-project fixed-window cap on candidate new issues. */
  newIssueCap?: { issues: number; windowSec: number };
  /** `allow` (default) fails open and logs an aggregate; `retry` fails the delivery. */
  onKvFailure?: "allow" | "retry";
}
export const RATE_REJECTION_BOUNDS = {
  maxCount: 1_000_000_000,
  minWindowSec: 1,
  maxWindowSec: 86_400,
} as const;
/** The issue API reports the dropped counter over this window; see {@link readDropped}. */
export function droppedWindowSec(
  config: RateRejectionConfig | undefined,
): number | undefined {
  return config?.issueRateLimit?.windowSec ?? config?.newIssueCap?.windowSec;
}
export function rateRejectionEnabled(
  config: RateRejectionConfig | undefined,
): config is RateRejectionConfig {
  return !!config && !!(config.issueRateLimit || config.newIssueCap);
}
const validCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= RATE_REJECTION_BOUNDS.maxCount;
/**
 * Reject project limits that the stack does not allow: only counts that tighten a limit the stack
 * enables are valid. Used when an operator writes the limits.
 */
export function validateProjectRateLimits(
  config: RateRejectionConfig | undefined,
  limits: ProjectRateLimits,
): void {
  const check = (
    name: string,
    value: number | undefined,
    stack: number | undefined,
  ) => {
    if (value === undefined) return;
    if (stack === undefined)
      throw new RangeError(
        `The stack does not enable a ${name} limit, so a project cannot set one`,
      );
    if (!validCount(value))
      throw new RangeError(`Project ${name} limit must be a positive integer`);
    if (value > stack)
      throw new RangeError(
        `Project ${name} limit ${value} exceeds the stack limit of ${stack}`,
      );
  };
  check("issue event", limits.issueEvents, config?.issueRateLimit?.events);
  check("new issue", limits.newIssues, config?.newIssueCap?.issues);
}
/**
 * The limits in force for a project: the lower of the stack's limit and the project's, for a limit
 * the stack enables. A project value for a disabled limit is ignored, and an invalid or higher one
 * is clamped, so a corrupt row can never loosen the stack's protection.
 */
export function effectiveRateLimits(
  config: RateRejectionConfig | undefined,
  limits?: ProjectRateLimits,
): { issueEvents?: number; newIssues?: number } {
  const lower = (stack: number | undefined, project: unknown) =>
    stack === undefined
      ? undefined
      : validCount(project)
        ? Math.min(stack, project)
        : stack;
  const issueEvents = lower(
    config?.issueRateLimit?.events,
    limits?.issueEvents,
  );
  const newIssues = lower(config?.newIssueCap?.issues, limits?.newIssues);
  return {
    ...(issueEvents === undefined ? {} : { issueEvents }),
    ...(newIssues === undefined ? {} : { newIssues }),
  };
}
export interface RejectionCandidate {
  projectId: ProjectId;
  issueId: string;
  eventId: string;
  receivedAt: Timestamp;
}
const bucketOf = (at: Timestamp, windowSec: number): number => {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new RangeError("Invalid receivedAt");
  return Math.floor(ms / (windowSec * 1000));
};
const issueRateKey = (c: RejectionCandidate, bucket: number) =>
  `rate:issue:${c.projectId}:${c.issueId}:${bucket}`;
const droppedKey = (
  projectId: string,
  issueId: string,
  bucket: number,
): string => `rate:dropped:${projectId}:${issueId}:${bucket}`;

/** Marker and outcome keys; `kind` keeps the three decision families and their windows apart. */
type DecisionKind = "issue" | "new" | "dropped";
const markerKey = (
  kind: DecisionKind,
  projectId: string,
  id: string,
  bucket: number,
): string => `rate:charged:${kind}:${projectId}:${id}:${bucket}`;
const outcomeKey = (
  kind: DecisionKind,
  projectId: string,
  id: string,
  bucket: number,
): string => `rate:outcome:${kind}:${projectId}:${id}:${bucket}`;

/** Wait for every operation (none keeps running after a failure), then rethrow the first failure. */
async function settleAll<T>(operations: readonly Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  const values: T[] = [];
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
    values.push(result.value);
  }
  return values;
}

/** One candidate in a decision pass; `marker` is the first-attempt key, `counter` the charged one. */
interface Entry {
  index: number;
  marker: string;
  outcome: string;
  counter: string;
  limit: number;
}

/** Fixed-window decisions over KV counters; every method takes candidates in deterministic input order. */
export class RateRejector {
  constructor(
    private readonly options: {
      kv: KV;
      config: RateRejectionConfig;
      logger: Logger;
      /**
       * Resolves per-project overrides. Reads are memoized only when `limitCache` is given (one
       * per delivery batch), so a long-lived rejector never serves stale limits. A read failure
       * propagates to the caller; it is not a KV failure and is not subject to `onKvFailure`.
       */
      projects?: Pick<ProjectRepo, "get">;
      limitCache?: Map<string, Promise<ProjectRateLimits | undefined>>;
    },
  ) {
    const { issueRateLimit, newIssueCap, onKvFailure } = options.config;
    const valid = (count: number, window: number) =>
      Number.isSafeInteger(count) &&
      count >= 1 &&
      count <= RATE_REJECTION_BOUNDS.maxCount &&
      Number.isSafeInteger(window) &&
      window >= RATE_REJECTION_BOUNDS.minWindowSec &&
      window <= RATE_REJECTION_BOUNDS.maxWindowSec;
    if (
      (issueRateLimit &&
        !valid(issueRateLimit.events, issueRateLimit.windowSec)) ||
      (newIssueCap && !valid(newIssueCap.issues, newIssueCap.windowSec)) ||
      (onKvFailure !== undefined &&
        onKvFailure !== "allow" &&
        onKvFailure !== "retry")
    )
      throw new RangeError("Invalid rate rejection configuration");
  }
  /** Isolate and aggregate failures for one delivery batch, including concurrent calls. */
  batch(): {
    rejector: RateRejector;
    flush: () => void;
    hasFailures: () => boolean;
  } {
    let failures = 0;
    let affected = 0;
    const operations = new Set<string>();
    let flushed = false;
    const logger: Logger = {
      debug: (message, fields) => this.options.logger.debug(message, fields),
      info: (message, fields) => this.options.logger.info(message, fields),
      error: (message, fields) => this.options.logger.error(message, fields),
      warn: (_message, fields) => {
        failures++;
        if (typeof fields?.affected === "number") affected += fields.affected;
        if (typeof fields?.operation === "string")
          operations.add(fields.operation);
      },
    };
    return {
      rejector: new RateRejector({
        ...this.options,
        logger,
        limitCache: new Map(),
      }),
      hasFailures: () => failures > 0,
      flush: () => {
        if (flushed) return;
        flushed = true;
        if (failures)
          this.options.logger.warn("Rate rejection KV failure", {
            failures,
            affected,
            operations: [...operations].sort(),
            failurePolicy: this.options.config.onKvFailure ?? "allow",
          });
      },
    };
  }
  /** Effective limits per distinct project, each project read at most once per batch scope. */
  private async limitsByProject(
    candidates: readonly RejectionCandidate[],
  ): Promise<Map<string, { issueEvents?: number; newIssues?: number }>> {
    const { projects, limitCache, config } = this.options;
    const ids = [...new Set(candidates.map((c) => c.projectId))];
    const entries = await settleAll(
      ids.map(async (id) => {
        if (!projects) return [id, effectiveRateLimits(config)] as const;
        let read = limitCache?.get(id);
        if (!read) {
          read = projects.get(id).then((project) => project?.rateLimits);
          limitCache?.set(id, read);
        }
        return [id, effectiveRateLimits(config, await read)] as const;
      }),
    );
    return new Map(entries);
  }
  get issueLimitEnabled(): boolean {
    return !!this.options.config.issueRateLimit;
  }
  get newIssueCapEnabled(): boolean {
    return !!this.options.config.newIssueCap;
  }
  /** Run a KV step under the stack's failure policy: fail open with an aggregate log, or rethrow for retry. */
  private async guard<T>(
    operation: string,
    affected: number,
    run: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const failurePolicy = this.options.config.onKvFailure ?? "allow";
      this.options.logger.warn("Rate rejection KV failure", {
        operation,
        affected,
        failurePolicy,
      });
      if (failurePolicy === "retry") throw error;
      return fallback;
    }
  }
  /**
   * Decide entries exactly once per marker. Entries sharing a marker within the call share the
   * first one's verdict. A first attempt charges its counter by the group size (the first
   * entries in input order fit the remaining budget) and stores the decision; a retry reuses the
   * stored decision without charging, or is admitted uncharged when none was stored.
   */
  private async decide(
    operation: string,
    entries: readonly Entry[],
    ttlSec: number,
    verdicts: boolean[],
  ): Promise<void> {
    const byMarker = new Map<string, Entry>();
    const followers: { entry: Entry; leader: Entry }[] = [];
    const leaders: Entry[] = [];
    for (const entry of entries) {
      const leader = byMarker.get(entry.marker);
      if (leader) followers.push({ entry, leader });
      else {
        byMarker.set(entry.marker, entry);
        leaders.push(entry);
      }
    }
    const attempts = await this.markFirst(
      operation,
      leaders.map((entry) => entry.marker),
      ttlSec,
    );
    const first: Entry[] = [];
    const retries: Entry[] = [];
    leaders.forEach((entry, i) => {
      const attempt = attempts[i] ?? 0;
      if (attempt === 1) first.push(entry);
      else if (attempt > 1) retries.push(entry);
    });
    await settleAll(
      retries.map((entry) =>
        this.guard(
          operation,
          1,
          async () => {
            const stored = await this.options.kv.get(entry.outcome);
            if (stored === "reject") verdicts[entry.index] = false;
          },
          undefined,
        ),
      ),
    );
    const groups = new Map<string, Entry[]>();
    for (const entry of first) {
      const group = groups.get(entry.counter) ?? [];
      group.push(entry);
      groups.set(entry.counter, group);
    }
    await settleAll(
      [...groups].map(([counter, group]) =>
        this.guard(
          operation,
          group.length,
          async () => {
            let count: number;
            try {
              count = await this.options.kv.increment(counter, group.length, {
                ttlSec,
              });
            } catch (error) {
              // Not charged: let a retry charge again instead of silently skipping.
              await Promise.allSettled(
                group.map((entry) => this.options.kv.delete(entry.marker)),
              );
              throw error;
            }
            const before = count - group.length;
            const decided = group.map((entry, k) => ({
              entry,
              admit: before + k + 1 <= entry.limit,
            }));
            for (const { entry, admit } of decided)
              verdicts[entry.index] = admit;
            await settleAll(
              decided.map(({ entry, admit }) =>
                this.options.kv.put(entry.outcome, admit ? "admit" : "reject", {
                  ttlSec,
                }),
              ),
            );
          },
          undefined,
        ),
      ),
    );
    for (const { entry, leader } of followers)
      verdicts[entry.index] = verdicts[leader.index] ?? true;
  }
  /**
   * Increment each marker once. Result 1 is a first attempt; a larger value is a retry. A failed
   * marker fails open (0) under `allow`; under `retry` the markers this call set are deleted again
   * so the retried delivery decides afresh.
   */
  private async markFirst(
    operation: string,
    markers: readonly string[],
    ttlSec: number,
  ): Promise<number[]> {
    const results = await Promise.allSettled(
      markers.map((marker) =>
        this.guard(
          operation,
          1,
          () => this.options.kv.increment(marker, 1, { ttlSec }),
          0,
        ),
      ),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      await Promise.allSettled(
        markers.flatMap((marker, i) => {
          const result = results[i];
          return result?.status === "fulfilled" && result.value === 1
            ? [this.options.kv.delete(marker)]
            : [];
        }),
      );
      throw failed.reason;
    }
    return results.map((result) =>
      result.status === "fulfilled" ? result.value : 0,
    );
  }
  /**
   * Per-issue limit. Each event is charged once per window however often it is attempted;
   * events of one (project, issue, window) are counted with one increment by the group size and
   * the first events in input order fit the remaining budget.
   * Returns one verdict per candidate (true = accepted).
   */
  async admitIssueEvents(
    candidates: readonly RejectionCandidate[],
  ): Promise<boolean[]> {
    const limit = this.options.config.issueRateLimit;
    const verdicts = candidates.map(() => true);
    if (!limit || !candidates.length) return verdicts;
    const limits = await this.limitsByProject(candidates);
    const entries = candidates.map((candidate, index): Entry => {
      const bucket = bucketOf(candidate.receivedAt, limit.windowSec);
      return {
        index,
        marker: markerKey(
          "issue",
          candidate.projectId,
          candidate.eventId,
          bucket,
        ),
        outcome: outcomeKey(
          "issue",
          candidate.projectId,
          candidate.eventId,
          bucket,
        ),
        counter: issueRateKey(candidate, bucket),
        limit: limits.get(candidate.projectId)?.issueEvents ?? limit.events,
      };
    });
    await this.decide("issue-rate", entries, limit.windowSec * 2, verdicts);
    return verdicts;
  }
  /**
   * Per-project new-issue cap. Candidates must be distinct issues that the caller observed as
   * absent. A candidate issue is charged once per window across batches, redeliveries and
   * concurrent consumers; a concurrent attempt that finds no stored decision yet is admitted
   * uncharged.
   */
  async admitNewIssues(
    candidates: readonly RejectionCandidate[],
  ): Promise<boolean[]> {
    const cap = this.options.config.newIssueCap;
    const verdicts = candidates.map(() => true);
    if (!cap || !candidates.length) return verdicts;
    const limits = await this.limitsByProject(candidates);
    const entries = candidates.map((candidate, index): Entry => {
      const bucket = bucketOf(candidate.receivedAt, cap.windowSec);
      return {
        index,
        marker: markerKey(
          "new",
          candidate.projectId,
          candidate.issueId,
          bucket,
        ),
        outcome: outcomeKey(
          "new",
          candidate.projectId,
          candidate.issueId,
          bucket,
        ),
        counter: `rate:new-issues:${candidate.projectId}:${bucket}`,
        limit: limits.get(candidate.projectId)?.newIssues ?? cap.issues,
      };
    });
    await this.decide("new-issue-cap", entries, cap.windowSec * 2, verdicts);
    return verdicts;
  }
  /**
   * Record dropped counts, once per event and window however often the rejection is replayed,
   * following the configured KV failure policy. A crash can still lose an increment.
   */
  async recordDropped(rejected: readonly RejectionCandidate[]): Promise<void> {
    const windowSec = droppedWindowSec(this.options.config);
    if (!windowSec || !rejected.length) return;
    const ttlSec = windowSec * 2;
    const byMarker = new Map<string, string>();
    for (const candidate of rejected) {
      const bucket = bucketOf(candidate.receivedAt, windowSec);
      byMarker.set(
        markerKey("dropped", candidate.projectId, candidate.eventId, bucket),
        droppedKey(candidate.projectId, candidate.issueId, bucket),
      );
    }
    const markers = [...byMarker.keys()];
    const attempts = await this.markFirst("dropped-counter", markers, ttlSec);
    const groups = new Map<string, string[]>();
    markers.forEach((marker, i) => {
      const counter = byMarker.get(marker);
      if (attempts[i] !== 1 || !counter) return;
      const group = groups.get(counter) ?? [];
      group.push(marker);
      groups.set(counter, group);
    });
    await settleAll(
      [...groups].map(([counter, group]) =>
        this.guard(
          "dropped-counter",
          group.length,
          async () => {
            try {
              await this.options.kv.increment(counter, group.length, {
                ttlSec,
              });
            } catch (error) {
              // Not charged: let a retry count the drops again.
              await Promise.allSettled(
                group.map((marker) => this.options.kv.delete(marker)),
              );
              throw error;
            }
          },
          undefined,
        ),
      ),
    );
  }
}
/** Dropped events for one issue in the current fixed window; approximate by design. */
export async function readDropped(
  kv: KV,
  config: RateRejectionConfig | undefined,
  projectId: string,
  issueId: string,
  now: Timestamp,
): Promise<{ count: number; windowSec: number } | null> {
  const windowSec = droppedWindowSec(config);
  if (!windowSec) return null;
  const bucket = bucketOf(now, windowSec);
  try {
    const value = await kv.get(droppedKey(projectId, issueId, bucket));
    if (value === null) return { count: 0, windowSec };
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      return null;
    return { count: Number(value), windowSec };
  } catch {
    return null;
  }
}
