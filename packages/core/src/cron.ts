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
    store: Pick<ActiveStore, "projects" | "events">;
    blobs: BlobStore;
    archived?: boolean;
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
      await runBundleCleanup({ ...cleanup, logger }, firedAt, cleanup.limits);
      return;
    }
    if (name === "archive-planner" && archival) {
      await runArchivePlanner({ ...archival, logger }, firedAt);
      return;
    }
    if (name === "retention" && retention) {
      if (retention.archived) {
        // TODO(M4h): archive-side hard retention hooks.
        logger.info("Retention left to archival", { job: name });
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
