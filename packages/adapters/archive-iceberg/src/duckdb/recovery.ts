// Classification of engine failures the store can recover from. Pure; no DuckDB import.
import type { S3Credentials } from "./session.js";

/** Refresh the S3 secret this long before the credentials' stated expiry. */
export const CREDENTIAL_REFRESH_SKEW_MS = 5 * 60_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An S3 request rejected for its credentials (httpfs reports `HTTP GET error ... (HTTP 403)` with
 * the S3 error body). Matched conservatively: a bare "403" elsewhere does not qualify.
 */
export function isS3AuthFailure(error: unknown): boolean {
  return /\(HTTP 403\)|HTTP (?:GET |PUT |POST |HEAD |DELETE )?error[\s\S]{0,200}?\b403\b|\bExpiredToken\b|\bInvalidAccessKeyId\b|\bRequestExpired\b|security token included in the request is (?:expired|invalid)/i.test(
    messageOf(error),
  );
}

/** Milliseconds since the epoch of a credential expiry, or undefined when absent or unparsable. */
export function expiryMs(
  expiration: S3Credentials["expiration"],
): number | undefined {
  if (expiration === undefined) return undefined;
  const value =
    expiration instanceof Date
      ? expiration.getTime()
      : typeof expiration === "number"
        ? expiration
        : Date.parse(expiration);
  return Number.isFinite(value) ? value : undefined;
}

/** Strip credential values out of a message (DuckDB may echo the failing statement). */
export function redactCredentials(
  message: string,
  credentials: S3Credentials | undefined,
): string {
  let out = message;
  if (credentials)
    for (const value of [
      credentials.accessKeyId,
      credentials.secretAccessKey,
      credentials.sessionToken,
    ])
      if (value) out = out.split(value).join("[redacted]");
  return out;
}
