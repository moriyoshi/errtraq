/** Remove known credentials and common credential patterns before logging errors. */
export function redactLogText(
  text: string,
  credentials: readonly string[] = [],
): string {
  return credentials
    .reduce(
      (result, secret) =>
        secret ? result.replaceAll(secret, "[redacted]") : result,
      text,
    )
    .replace(
      /\b(authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(
      /\b(token|password|secret|sentry_key|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/(\w+:\/\/)[^\s/@]+@/g, "$1[redacted]@");
}
