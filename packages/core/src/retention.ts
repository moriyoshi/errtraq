import { type ProjectId, type Timestamp, toTimestamp } from "./domain.js";
import type { ActiveStore, BlobStore, Logger } from "./ports.js";

/** Largest delete chunk every store adapter accepts (DynamoDB batch writes cap at 25). */
const DELETE_CHUNK = 25;

export interface RetentionSweepOptions {
  store: Pick<ActiveStore, "events">;
  blobs: BlobStore;
  logger: Pick<Logger, "warn">;
  projectId: ProjectId;
  retentionDays: number;
  now: Timestamp;
  /** Upper bound on events deleted by one call; the caller re-runs while `hasMore`. */
  maxEvents?: number;
}
export interface RetentionSweepResult {
  deleted: number;
  /** Overflow blobs whose deletion failed; they are orphans for the bucket lifecycle rule. */
  blobFailures: number;
  hasMore: boolean;
}

/** Only per-event overflow payloads are ever deleted here, never claim checks or other keys. */
export const ownsOverflowBlob = (projectId: ProjectId, key: string) =>
  key.startsWith(`payloads/${projectId}/`);

/**
 * Delete events older than the project's retention, then their overflow payloads.
 *
 * The order is load-bearing. The event is deleted first and its blob second (best effort):
 * a crash in between leaves an unreferenced orphan blob, which the bucket lifecycle rule on
 * overflow payloads sweeps after the stack's longest retention plus a margin. The reverse
 * order could leave a live event whose payload is gone.
 *
 * This sweep runs only for stacks without an archive. With an archive selected, the archival
 * worker deletes events after commit and owns the overflow blobs (see archival.ts); the `retention`
 * cron job then leaves events alone and runs archive housekeeping instead (archive-housekeeping.ts).
 * TODO(M4j): hand blob keys to the subject-erasure hook.
 */
export async function deleteExpiredEvents(
  options: RetentionSweepOptions,
): Promise<RetentionSweepResult> {
  if (!Number.isSafeInteger(options.retentionDays) || options.retentionDays < 1)
    throw new RangeError("retentionDays must be a positive integer");
  const cutoff = toTimestamp(
    new Date(Date.parse(options.now) - options.retentionDays * 86_400_000),
  );
  const budget = options.maxEvents ?? 500;
  let deleted = 0;
  let blobFailures = 0;
  while (deleted < budget) {
    // Finished batches are gone, so the oldest remaining row is always first: no cursor.
    const page = await options.store.events.scanOlderThan(
      options.projectId,
      cutoff,
      { limit: Math.min(DELETE_CHUNK, budget - deleted) },
    );
    if (!page.items.length) {
      if (!page.nextCursor) return { deleted, blobFailures, hasMore: false };
      throw new Error("Retention scan returned an empty page with a cursor");
    }
    await options.store.events.deleteBatch(
      options.projectId,
      page.items.map((item) => item.eventId),
    );
    deleted += page.items.length;
    for (const { eventId, payloadBlobKey } of page.items) {
      if (!payloadBlobKey) continue;
      if (!ownsOverflowBlob(options.projectId, payloadBlobKey)) {
        options.logger.warn("Skipping unexpected overflow payload key", {
          eventId,
        });
        continue;
      }
      try {
        await options.blobs.delete(payloadBlobKey);
      } catch {
        blobFailures++;
        options.logger.warn("Overflow payload deletion failed", { eventId });
      }
    }
  }
  return { deleted, blobFailures, hasMore: true };
}
