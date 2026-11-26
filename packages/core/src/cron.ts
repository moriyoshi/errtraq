import {
  type ArchiveHousekeepingOptions,
  runArchiveHousekeeping,
} from "./archive-housekeeping.js";
import { runArchivePlanner } from "./archive-planner.js";
import {
  type BundleCleanupLimits,
  runBundleCleanup,
} from "./bundle-cleanup.js";
import type {
  ActiveStore,
  BlobStore,
  CronHandler,
  Logger,
  ProjectRepo,
  QueueProducer,
} from "./ports.js";
import { recoverStagedEnvelopes } from "./recover-ingest.js";
import { deleteExpiredEvents } from "./retention.js";
import { CRON_JOBS } from "./stack-model.js";
import { deleteExpiredStats } from "./stats.js";

/** Job registry: known jobs acknowledge after logging until implementations land. */
export function createCronHandler(
  logger: Pick<Logger, "info" | "warn" | "error">,
  recovery?: { blobs: BlobStore; queue: QueueProducer },
  cleanup?: {
    projects: Pick<ProjectRepo, "list">;
    releases: Parameters<typeof runBundleCleanup>[0]["releases"];
    blobs: BlobStore;
    limits?: BundleCleanupLimits;
  },
  /** Present when an archive is selected: enables the `archive-planner` job. */
  archival?: { projects: Pick<ProjectRepo, "list">; queue: QueueProducer },
  /**
   * The `retention` job. With `archived` set (an archive is selected) it leaves events to the
   * archival worker, which deletes them after commit.
   */
  retention?: {
    store: Pick<ActiveStore, "projects" | "events" | "stats">;
    blobs: BlobStore;
    archived?: boolean;
    /** With `archived`: archive-side housekeeping (hard retention, orphan sweeps, lag alarm). */
    housekeeping?: Omit<ArchiveHousekeepingOptions, "logger">;
    /** Upper bound on events deleted per project per tick. */
    maxEventsPerProject?: number;
  },
): CronHandler {
  const jobs: ReadonlyMap<string, CronHandler> = new Map(
    CRON_JOBS.map((job) => [
      job.name,
      async () => logger.warn("Cron job not implemented", { job: job.name }),
    ]),
  );
  return async (name, firedAt) => {
    if (name === "staged-recovery") {
      if (!recovery)
        throw new Error("Staged envelope recovery adapters are missing");
      await recoverStagedEnvelopes(recovery.blobs, recovery.queue, logger, {
        now: firedAt,
        minimumAgeMs: 10 * 60 * 1000,
      });
      return;
    }
    if (name === "bundle-cleanup") {
      if (!cleanup) throw new Error("Bundle cleanup adapters are missing");
      await runBundleCleanup(
        { ...cleanup, logger, persistCursor: true },
        firedAt,
        cleanup.limits,
      );
      return;
    }
    if (name === "archive-planner" && archival) {
      await runArchivePlanner({ ...archival, logger }, firedAt);
      return;
    }
    if (name === "retention" && retention) {
      // Hourly statistics buckets are not events: they expire on the same cron in both modes.
      if (retention.store.stats?.expiry === "explicit") {
        let statsCursor: Parameters<ProjectRepo["list"]>[0];
        do {
          const page = await retention.store.projects.list(statsCursor, 100);
          for (const project of page.items) {
            const swept = await deleteExpiredStats({
              store: retention.store,
              projectId: project.id,
              now: firedAt,
            });
            if (swept.deleted)
              logger.info("Statistics bucket sweep", {
                projectId: project.id,
                deleted: swept.deleted,
                hasMore: swept.hasMore,
              });
          }
          statsCursor = page.nextCursor ?? undefined;
        } while (statsCursor);
      }
      if (retention.archived) {
        if (retention.housekeeping)
          await runArchiveHousekeeping(
            { ...retention.housekeeping, logger },
            firedAt,
          );
        else logger.info("Retention left to archival", { job: name });
        return;
      }
      let cursor: Parameters<ProjectRepo["list"]>[0];
      do {
        const page = await retention.store.projects.list(cursor, 100);
        for (const project of page.items) {
          const swept = await deleteExpiredEvents({
            store: retention.store,
            blobs: retention.blobs,
            logger,
            projectId: project.id,
            retentionDays: project.retentionDays,
            now: firedAt,
            maxEvents: retention.maxEventsPerProject,
          });
          if (swept.deleted)
            logger.info("Retention sweep", {
              projectId: project.id,
              deleted: swept.deleted,
              hasMore: swept.hasMore,
            });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return;
    }
    const job = jobs.get(name);
    if (!job) {
      logger.error("Unknown or missing cron job");
      return;
    }
    await job(name, firedAt);
  };
}
