/** Missing staged claims are acknowledged on this receive attempt. */
export const CONSUMER_MAX_MISSING_ATTEMPTS = 5;
/** Later milestones must add handlers before enabling their routes at runtime. */
export function assertImplementedConsumerTopics(
  topics: readonly string[],
): void {
  for (const topic of topics)
    if (topic !== "ingest")
      throw new Error(
        `Queue topic ${topic} has no implemented consumer handler`,
      );
}
