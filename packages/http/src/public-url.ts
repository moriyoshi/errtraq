/**
 * The configured public origin of the API, for absolute URLs in `Link` headers, issue
 * permalinks and the chunk-upload endpoint. Behind a CDN the request URL carries the function URL
 * host, not the one clients use. It is only ever taken from configuration: request headers such
 * as `X-Forwarded-Host` are viewer-controlled (a distribution forwards them to the origin), so
 * trusting them would let a client put its own host into `Link`.
 */
export function publicApiOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  if (
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    value.endsWith("?") ||
    value.endsWith("#")
  )
    throw new Error(
      "Invalid public API URL: expected an HTTP(S) origin without credentials, path, query or fragment",
    );
  return url.origin;
}

/** The request URL with its origin replaced by the configured public one, when there is one. */
export function publicRequestUrl(requestUrl: string, origin?: string): URL {
  const url = new URL(requestUrl);
  if (!origin) return url;
  const base = new URL(origin);
  url.protocol = base.protocol;
  url.host = base.host;
  return url;
}
