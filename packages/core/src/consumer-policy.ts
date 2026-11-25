/** Missing staged claims are acknowledged on this receive attempt. */
export const CONSUMER_MAX_MISSING_ATTEMPTS = 5;
/** Later milestones must add handlers before enabling their routes at runtime. */
export function assertImplementedConsumerTopics(
  topics: readonly string[],
  /** Standalone hosts every handler in one process and adds `archive.project` (M4g); AWS waits for M4i. */
  implemented: readonly string[] = ["ingest", "record"],
): void {
  for (const topic of topics)
    if (!implemented.includes(topic))
      throw new Error(
        `Queue topic ${topic} has no implemented consumer handler`,
      );
}
