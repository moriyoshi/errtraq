/**
 * Convert a retention bound and grace period to DynamoDB TTL epoch seconds.
 * The retention bound must be enforced durably by the caller; this calculation
 * does not authorize applying a TTL or prove that archival has completed.
 */
export function eventBackstopEpoch(
  receivedAt: string,
  retentionDays: number,
  graceDays: number,
): number {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    !Number.isSafeInteger(graceDays) ||
    graceDays < 0
  )
    throw new RangeError("Invalid event TTL retention or grace period");
  const received = Date.parse(receivedAt);
  if (
    !Number.isFinite(received) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(receivedAt) ||
    new Date(received).toISOString() !== receivedAt
  )
    throw new RangeError("Invalid event TTL receivedAt");
  const expiry = received + (retentionDays + graceDays) * 86_400_000;
  if (!Number.isSafeInteger(expiry))
    throw new RangeError("Event TTL expiry exceeds the safe integer range");
  // DynamoDB's epoch seconds must not round a millisecond expiry earlier.
  return Math.ceil(expiry / 1000);
}
