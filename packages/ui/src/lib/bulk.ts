/** The API accepts at most this many `id` parameters per bulk update request. */
export const BULK_LIMIT = 100;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("Invalid size");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export interface BatchResult {
  ids: string[];
  /** Absent when the batch succeeded. */
  error?: string;
}

/**
 * Send `ids` in batches of at most `size`, one after the other, and report each batch. A failed
 * batch does not stop the rest: the server validates every id of a request before writing, so a
 * batch either lands or leaves its issues untouched, and the user is told which ones failed.
 */
export async function runBatches(
  ids: readonly string[],
  send: (batch: string[]) => Promise<unknown>,
  size = BULK_LIMIT,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (const batch of chunk([...new Set(ids)], size)) {
    try {
      await send(batch);
      results.push({ ids: batch });
    } catch (error) {
      results.push({
        ids: batch,
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  }
  return results;
}

export interface BulkSummary {
  updated: string[];
  failed: string[];
  /** Human text for a failure; empty when everything landed. */
  message: string;
}

export function summarize(results: readonly BatchResult[]): BulkSummary {
  const updated = results.filter((r) => !r.error).flatMap((r) => r.ids);
  const failed = results.filter((r) => r.error).flatMap((r) => r.ids);
  const reasons = [
    ...new Set(results.flatMap((r) => (r.error ? [r.error] : []))),
  ];
  const total = updated.length + failed.length;
  return {
    updated,
    failed,
    message: failed.length
      ? `Updated ${updated.length} of ${total} issues; ${failed.length} failed: ${reasons.join("; ")}`
      : "",
  };
}

/** The query string of one bulk request: repeated `id` parameters. */
export function bulkQuery(ids: readonly string[]): string {
  return ids.map((id) => `id=${encodeURIComponent(id)}`).join("&");
}

interface PagedIssues {
  pages: { items: { id: string }[]; next?: string | undefined }[];
}

/** The cached pages of an infinite issue list without the given issues (the optimistic update). */
export function withoutIssues<T extends PagedIssues>(
  data: T,
  ids: ReadonlySet<string>,
): T {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((item) => !ids.has(item.id)),
    })),
  };
}
