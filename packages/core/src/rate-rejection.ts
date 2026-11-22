import type { ProjectId, Timestamp } from "./domain.js";
import type { KV, Logger } from "./ports.js";

/**
 * Stage 3 rate-based rejection (see SUBJECT_INDEX_DESIGN.md "Rate-based rejection").
 * Both limits are disabled unless configured. Counters are fixed-window `KV.increment`
 * values and therefore approximate: redelivery can double-charge and a crash can lose
 * a dropped-counter increment.
 */
// TODO(M3): support project overrides constrained by the stack limits.
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
export interface RejectionCandidate {
  projectId: ProjectId;
  issueId: string;
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

/** Fixed-window decisions over KV counters; every method takes candidates in deterministic input order. */
export class RateRejector {
  constructor(
    private readonly options: {
      kv: KV;
      config: RateRejectionConfig;
      logger: Logger;
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
   * Per-issue limit. Candidates are counted with one increment per (project, issue, window)
   * by the group size; within a group the first events in input order fit the remaining budget.
   * Returns one verdict per candidate (true = accepted).
   */
  async admitIssueEvents(
    candidates: readonly RejectionCandidate[],
  ): Promise<boolean[]> {
    const limit = this.options.config.issueRateLimit;
    const verdicts = candidates.map(() => true);
    if (!limit || !candidates.length) return verdicts;
    const groups = new Map<string, { key: string; indexes: number[] }>();
    candidates.forEach((candidate, index) => {
      const key = issueRateKey(
        candidate,
        bucketOf(candidate.receivedAt, limit.windowSec),
      );
      const group = groups.get(key) ?? { key, indexes: [] };
      group.indexes.push(index);
      groups.set(key, group);
    });
    await Promise.all(
      [...groups.values()].map((group) =>
        this.guard(
          "issue-rate",
          group.indexes.length,
          async () => {
            const count = await this.options.kv.increment(
              group.key,
              group.indexes.length,
              { ttlSec: limit.windowSec * 2 },
            );
            const room = Math.max(
              0,
              Math.min(
                group.indexes.length,
                limit.events - (count - group.indexes.length),
              ),
            );
            for (const index of group.indexes.slice(room))
              verdicts[index] = false;
          },
          undefined,
        ),
      ),
    );
    return verdicts;
  }
  /**
   * Per-project new-issue cap. Candidates must be distinct issues that the caller observed as
   * absent; the counter overcounts when concurrent candidates or retries observe the same absence.
   */
  async admitNewIssues(
    candidates: readonly RejectionCandidate[],
  ): Promise<boolean[]> {
    const cap = this.options.config.newIssueCap;
    const verdicts = candidates.map(() => true);
    if (!cap || !candidates.length) return verdicts;
    const groups = new Map<string, number[]>();
    candidates.forEach((candidate, index) => {
      const key = `rate:new-issues:${candidate.projectId}:${bucketOf(candidate.receivedAt, cap.windowSec)}`;
      const group = groups.get(key) ?? [];
      group.push(index);
      groups.set(key, group);
    });
    await Promise.all(
      [...groups].map(([key, indexes]) =>
        this.guard(
          "new-issue-cap",
          indexes.length,
          async () => {
            const count = await this.options.kv.increment(key, indexes.length, {
              ttlSec: cap.windowSec * 2,
            });
            const room = Math.max(
              0,
              Math.min(indexes.length, cap.issues - (count - indexes.length)),
            );
            for (const index of indexes.slice(room)) verdicts[index] = false;
          },
          undefined,
        ),
      ),
    );
    return verdicts;
  }
  /** Record approximate dropped counts, following the configured KV failure policy. */
  async recordDropped(rejected: readonly RejectionCandidate[]): Promise<void> {
    const windowSec = droppedWindowSec(this.options.config);
    if (!windowSec || !rejected.length) return;
    const groups = new Map<string, number>();
    for (const candidate of rejected) {
      const key = droppedKey(
        candidate.projectId,
        candidate.issueId,
        bucketOf(candidate.receivedAt, windowSec),
      );
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    await this.guard(
      "dropped-counter",
      rejected.length,
      async () => {
        await Promise.all(
          [...groups].map(([key, by]) =>
            this.options.kv.increment(key, by, { ttlSec: windowSec * 2 }),
          ),
        );
      },
      undefined,
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
