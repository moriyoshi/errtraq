import type { IssueFilter } from "../api/queries";
import type { IssueStatus } from "../api/schemas";

export const STATUSES: IssueStatus[] = ["unresolved", "resolved", "ignored"];
export const SORTS: { value: IssueFilter["sort"]; label: string }[] = [
  { value: "date", label: "Last seen" },
  { value: "new", label: "First seen" },
  { value: "freq", label: "Count" },
];

export interface IssueSearch {
  status?: IssueStatus;
  sort?: IssueFilter["sort"];
  q?: string;
}

/**
 * URL state is the source of truth for the issue list. Unknown or malformed values fall back to
 * the defaults, and defaults are omitted so the canonical URL stays short.
 */
export function validateIssueSearch(
  search: Record<string, unknown>,
): IssueSearch {
  const status = STATUSES.find((s) => s === search.status);
  const sort = SORTS.find((s) => s.value === search.sort)?.value;
  const q =
    typeof search.q === "string" && search.q.trim() ? search.q : undefined;
  return {
    ...(status && status !== "unresolved" ? { status } : {}),
    ...(sort && sort !== "date" ? { sort } : {}),
    ...(q ? { q } : {}),
  };
}

/**
 * Search params are plain strings. TanStack's default parser JSON-decodes values, which would
 * turn an all-digit event id into a lossy number; ours never does.
 */
export function parseSearch(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search))
    if (value !== undefined && value !== null && value !== "")
      params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}
