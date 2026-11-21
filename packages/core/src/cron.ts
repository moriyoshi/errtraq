import type { BlobStore, CronHandler, Logger, QueueProducer } from "./ports.js";
import { recoverStagedEnvelopes } from "./recover-ingest.js";
import { CRON_JOBS } from "./stack-model.js";

/** M4 job registry: known jobs acknowledge after logging until implementations land. */
export function createCronHandler(
  logger: Pick<Logger, "warn" | "error">,
  recovery?: { blobs: BlobStore; queue: QueueProducer },
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
    const job = jobs.get(name);
    if (!job) {
      logger.error("Unknown or missing cron job");
      return;
    }
    await job(name, firedAt);
  };
}
