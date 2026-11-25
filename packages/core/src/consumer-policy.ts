/** Missing staged claims are acknowledged on this receive attempt. */
export const CONSUMER_MAX_MISSING_ATTEMPTS = 5;
/** Later milestones must add handlers before enabling their routes at runtime. */
export function assertImplementedConsumerTopics(
  topics: readonly string[],
  /** Deployed functions host `ingest`, `record` and (the archive role, M4i) `archive.project`. */
  implemented: readonly string[] = ["ingest", "record", "archive.project"],
): void {
  for (const topic of topics)
    if (!implemented.includes(topic))
      throw new Error(
        `Queue topic ${topic} has no implemented consumer handler`,
      );
}
