import type { Logger } from "@errtraq/core";

/** Log an unexpected failure without request bodies or known authentication credentials. */
export function logUnexpected(
  logger: Pick<Logger, "error"> | undefined,
  error: unknown,
  request: Request,
): string {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);
  const credentials = [
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, ""),
    request.headers
      .get("x-sentry-auth")
      ?.match(/sentry_key\s*=\s*([^,\s]+)/i)?.[1],
    url.searchParams.get("sentry_key"),
    url.username,
  ].filter((value): value is string => !!value);
  const redact = (text: string) =>
    credentials
      .reduce((result, secret) => result.replaceAll(secret, "[redacted]"), text)
      .replace(
        /\b(authorization|token|password|secret|sentry_key|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[redacted]",
      )
      .replace(/(\w+:\/\/)[^\s/@]+@/g, "$1[redacted]@");
  const message = redact(
    error instanceof Error ? error.message : String(error),
  );
  const stack =
    error instanceof Error && error.stack ? redact(error.stack) : undefined;
  const fields = { requestId, message, ...(stack ? { stack } : {}) };
  if (logger) logger.error("HTTP request failed", fields);
  else console.error("HTTP request failed", fields);
  return requestId;
}
