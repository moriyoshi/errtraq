import {
  ARCHIVE_OVERFLOW_PREFIX,
  type ArchiveLease,
  ArchiveLeaseLostError,
  type ArchiveWorker,
} from "./archival.js";
import {
  type Cursor,
  isProjectId,
  type ProjectId,
  type Timestamp,
  toTimestamp,
} from "./domain.js";
import { UnsupportedQueryError } from "./errors.js";
import type { ActiveStore, ArchiveStore, BlobStore, Logger } from "./ports.js";

/**
 * Archive-side housekeeping, run by the `retention` cron job for stacks with an archive (the job
 * already owns "how long data lives"; a new cron job name would also change every generated
 * schedule, which is M4i's business). Every mutation of a project's archive rows or its
 * `archive-overflow/` manifests happens under that project's archive lease, after the batch in
 * flight (if any) was driven to completion: housekeeping never runs against a project holding a
 * `committing` or `committed` batch (M4_PLAN risks 4 and 5). A busy lease means "skip, next tick".
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PAGE = 100;
/** Default lag alarm: the archive planner runs hourly, so three missed runs is an incident. */
export const DEFAULT_ARCHIVE_LAG_ALARM_MS = 3 * HOUR_MS;
/** Default bound on manifests examined per tick (the rest waits for the next tick). */
export const DEFAULT_MAX_MANIFESTS = 1_000;

export class ArchiveBusyError extends Error {
  override name = "ArchiveBusyError";
}

export interface ArchiveHousekeepingOptions {
  store: Pick<ActiveStore, "projects" | "events" | "meta">;
  blobs: BlobStore;
  archive: ArchiveStore;
  /** Supplies the lease discipline (`acquire`, `driveBatchToCompletion`, `release`). */
  worker: Pick<ArchiveWorker, "acquire" | "release" | "driveBatchToCompletion">;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /**
   * Stack-wide bound on the total life of an event, counted from `receivedAt` (D12: a project's
   * `retentionDays` is the hot-tier age). Absent: the archive keeps rows forever. Must exceed
   * every project's `retentionDays`; a project where it does not is skipped with a warning
   * (otherwise rows would be deleted from the archive that were never archived yet).
   */
  archiveRetentionDays?: number;
  /** A project whose oldest un-archived row lags the hot cutoff by more than this raises the alarm. */
  lagAlarmMs?: number;
  /**
   * Age of the snapshots `expireSnapshots` may drop. Absent: not called. TODO(M4l): the DuckDB
   * engine has no verified expiry path yet, so the standalone wiring leaves this unset.
   */
  snapshotExpiryDays?: number;
  /** Upper bound on manifests examined per tick. */
  maxManifests?: number;
}

export interface ArchiveHousekeepingResult {
  projects: number;
  /** Archive rows deleted by hard retention. */
  retentionDeleted: number;
  /** Projects skipped because another holder had the lease. */
  busy: number;
  /** Projects whose lag exceeded the alarm threshold. */
  lagAlarms: number;
  /** Orphan `archive-overflow/` manifests deleted. */
  manifestsDeleted: number;
  snapshotsExpired: boolean;
}

/** Run `work` under the project's lease with no batch in flight; null when the lease is busy or lost. */
async function withLease<T>(
  options: Pick<ArchiveHousekeepingOptions, "worker" | "logger">,
  projectId: ProjectId,
  work: () => Promise<T>,
): Promise<T | null> {
  const { worker, logger } = options;
  const lease: ArchiveLease | null = await worker.acquire(projectId);
  if (!lease) return null;
  try {
    // A batch left behind by a crashed run is finished first (its rows may be below any cutoff).
    if (lease.state.batch)
      await worker.driveBatchToCompletion(projectId, lease);
    const result = await work();
    await worker.release(lease);
    return result;
  } catch (error) {
    if (error instanceof ArchiveLeaseLostError) {
      logger.warn("Archive housekeeping lost the lease", { projectId });
      return null;
    }
    // The lease is left to expire; releasing could mask the original failure.
    throw error;
  }
}

/** Project deletion against the archive: every archive row of the project, under its lease. */
export async function purgeProjectArchive(
  options: Pick<ArchiveHousekeepingOptions, "archive" | "worker" | "logger">,
  projectId: ProjectId,
): Promise<{ rowsDeleted: number }> {
  const result = await withLease(options, projectId, () =>
    options.archive.deleteProject(projectId),
  );
  if (!result)
    throw new ArchiveBusyError(
      `Archive of project ${projectId} is busy; retry later`,
    );
  options.logger.info("Archive project purge", {
    projectId,
    rowsDeleted: result.rowsDeleted,
  });
  return result;
}

/** The project a manifest key belongs to (`archive-overflow/<enc(projectId/seq)>-<owner>-<n>.json`). */
export function manifestProjectId(key: string): ProjectId | null {
  if (!key.startsWith(ARCHIVE_OVERFLOW_PREFIX)) return null;
  const name = key.slice(ARCHIVE_OVERFLOW_PREFIX.length);
  const end = name.indexOf("%2F");
  if (end < 1) return null;
  try {
    const id = decodeURIComponent(name.slice(0, end));
    return isProjectId(id) ? id : null;
  } catch {
    return null;
  }
}

async function sweepManifests(
  options: ArchiveHousekeepingOptions,
  result: ArchiveHousekeepingResult,
): Promise<void> {
  const { blobs, logger, store } = options;
  const limit = options.maxManifests ?? DEFAULT_MAX_MANIFESTS;
  const byProject = new Map<ProjectId, string[]>();
  let cursor: Cursor | undefined;
  let seen = 0;
  do {
    const page = await blobs.list(ARCHIVE_OVERFLOW_PREFIX, cursor, PAGE);
    for (const key of page.items) {
      if (seen++ >= limit) break;
      const projectId = manifestProjectId(key);
      if (!projectId) {
        logger.warn("Unrecognized archive overflow manifest", { key });
        continue;
      }
      const keys = byProject.get(projectId) ?? [];
      keys.push(key);
      byProject.set(projectId, keys);
    }
    cursor = seen < limit ? (page.nextCursor ?? undefined) : undefined;
  } while (cursor);
  const deleteAll = async (keys: string[]) => {
    for (const key of keys) {
      try {
        await blobs.delete(key);
        result.manifestsDeleted++;
      } catch {
        logger.warn("Orphan manifest deletion failed", { key });
      }
    }
  };
  for (const [projectId, keys] of byProject) {
    // Only manifests are removed, never the payload keys they list: after an abandoned batch the
    // active rows still reference those payloads (a finished batch already deleted them).
    if (!(await store.projects.get(projectId))) {
      await deleteAll(keys); // no worker runs for an unknown project
      continue;
    }
    // Under the lease no worker can create or consume a manifest of this project, and a batch in
    // flight was driven to completion (deleting its own manifest), so every key left is orphaned.
    const done = await withLease(options, projectId, () => deleteAll(keys));
    if (done === null) result.busy++;
  }
}

/**
 * The housekeeping tick: lag alarm and hard retention per project, orphan manifest sweep, and
 * snapshot expiry when configured. Idempotent; a failure in one project is logged and the tick
 * moves on (the error is rethrown at the end so the scheduler still sees it).
 */
export async function runArchiveHousekeeping(
  options: ArchiveHousekeepingOptions,
  firedAt: Timestamp,
): Promise<ArchiveHousekeepingResult> {
  const { store, archive, logger } = options;
  const now = Date.parse(firedAt);
  const lagAlarmMs = options.lagAlarmMs ?? DEFAULT_ARCHIVE_LAG_ALARM_MS;
  if (
    options.archiveRetentionDays !== undefined &&
    (!Number.isSafeInteger(options.archiveRetentionDays) ||
      options.archiveRetentionDays < 1)
  )
    throw new RangeError("archiveRetentionDays must be a positive integer");
  const result: ArchiveHousekeepingResult = {
    projects: 0,
    retentionDeleted: 0,
    busy: 0,
    lagAlarms: 0,
    manifestsDeleted: 0,
    snapshotsExpired: false,
  };
  const failures: unknown[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await store.projects.list(cursor, PAGE);
    for (const project of page.items) {
      result.projects++;
      try {
        const hotCutoff = toTimestamp(
          new Date(now - project.retentionDays * DAY_MS),
        );
        // Lag alarm: the oldest row still in the active store below the hot cutoff.
        const oldest = (
          await store.events.scanOlderThan(project.id, hotCutoff, { limit: 1 })
        ).items[0];
        if (oldest) {
          const lagMs = Date.parse(hotCutoff) - Date.parse(oldest.receivedAt);
          if (lagMs > lagAlarmMs) {
            result.lagAlarms++;
            logger.warn("Archival lag alarm", {
              alarm: "archival-lag",
              projectId: project.id,
              lagMs,
              thresholdMs: lagAlarmMs,
            });
          }
        }
        if (options.archiveRetentionDays === undefined) continue;
        if (options.archiveRetentionDays <= project.retentionDays) {
          logger.warn(
            "archiveRetentionDays must exceed the project retentionDays; skipping hard retention",
            { projectId: project.id },
          );
          continue;
        }
        const cutoff = toTimestamp(
          new Date(now - options.archiveRetentionDays * DAY_MS),
        );
        const deleted = await withLease(options, project.id, () =>
          archive.deleteOlderThan(project.id, cutoff),
        );
        if (!deleted) {
          result.busy++;
          continue;
        }
        result.retentionDeleted += deleted.rowsDeleted;
        if (deleted.rowsDeleted)
          logger.info("Archive hard retention", {
            projectId: project.id,
            rowsDeleted: deleted.rowsDeleted,
          });
      } catch (error) {
        logger.error("Archive housekeeping failed for a project", {
          projectId: project.id,
          error: String(error),
        });
        failures.push(error);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  try {
    await sweepManifests(options, result);
  } catch (error) {
    logger.error("Archive manifest sweep failed", { error: String(error) });
    failures.push(error);
  }
  if (options.snapshotExpiryDays !== undefined) {
    try {
      await archive.expireSnapshots(
        toTimestamp(new Date(now - options.snapshotExpiryDays * DAY_MS)),
      );
      result.snapshotsExpired = true;
    } catch (error) {
      if (error instanceof UnsupportedQueryError)
        logger.info("Snapshot expiry is not supported by this archive", {});
      else {
        logger.error("Snapshot expiry failed", { error: String(error) });
        failures.push(error);
      }
    }
  }
  logger.info("Archive housekeeping finished", { ...result });
  if (failures.length)
    throw new AggregateError(failures, "Archive housekeeping had failures");
  return result;
}
