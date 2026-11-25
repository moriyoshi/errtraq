import {
  type BundleCleanupLimits,
  runBundleCleanup,
} from "./bundle-cleanup.js";
import type {
  BlobStore,
  CronHandler,
  Logger,
  ProjectRepo,
  QueueProducer,
} from "./ports.js";
import { recoverStagedEnvelopes } from "./recover-ingest.js";
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
    const job = jobs.get(name);
    if (!job) {
      logger.error("Unknown or missing cron job");
      return;
    }
    await job(name, firedAt);
  };
}
