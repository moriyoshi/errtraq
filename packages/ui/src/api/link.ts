/** One relation of a Sentry-style `Link` header. */
export interface LinkRelation {
  /** Opaque cursor to pass back as `?cursor=`. */
  cursor: string;
  /** Sentry's `results` flag: whether following this relation can yield items. */
  results: boolean;
}

export interface ParsedLinks {
  previous: LinkRelation | null;
  next: LinkRelation | null;
}

const LINK = /<([^>]*)>((?:\s*;\s*[A-Za-z][\w-]*\s*=\s*"[^"]*")*)/g;
const PARAM = /([A-Za-z][\w-]*)\s*=\s*"([^"]*)"/g;

/**
 * Parse Sentry's `Link` header, for example
 * `<url>; rel="next"; results="true"; cursor="0:100:0"`. A missing header, an unknown relation
 * and a relation without a cursor all yield `null`. `results="false"` is kept (it means the
 * server knows the relation has no more items), see {@link nextCursor}.
 */
export function parseLinkHeader(
  header: string | null | undefined,
): ParsedLinks {
  const out: ParsedLinks = { previous: null, next: null };
  if (!header) return out;
  for (const match of header.matchAll(LINK)) {
    const params = new Map<string, string>();
    for (const p of (match[2] ?? "").matchAll(PARAM))
      if (p[1] && p[2] !== undefined) params.set(p[1].toLowerCase(), p[2]);
    const rel = params.get("rel");
    if (rel !== "next" && rel !== "previous") continue;
    const cursor = params.get("cursor");
    if (!cursor) continue;
    out[rel] = { cursor, results: params.get("results") === "true" };
  }
  return out;
}

/**
 * The cursor to request the next page with, or `undefined` when the listing is exhausted. A page
 * may be short or empty and still have a next cursor; only `results="false"` ends the listing.
 */
export function nextCursor(
  header: string | null | undefined,
): string | undefined {
  const next = parseLinkHeader(header).next;
  return next?.results ? next.cursor : undefined;
}
