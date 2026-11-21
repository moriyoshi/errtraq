import type { CronHandler, Logger } from "./ports.js";
import { CRON_JOBS } from "./stack-model.js";

/** M4 job registry: known jobs acknowledge after logging until implementations land. */
export function createCronHandler(
  logger: Pick<Logger, "warn" | "error">,
): CronHandler {
  const jobs: ReadonlyMap<string, CronHandler> = new Map(
    CRON_JOBS.map((job) => [
      job.name,
      async () => logger.warn("Cron job not implemented", { job: job.name }),
    ]),
  );
  return async (name, firedAt) => {
    const job = jobs.get(name);
    if (!job) {
      logger.error("Unknown or missing cron job");
      return;
    }
    await job(name, firedAt);
  };
}
