import type { InfiniteData, QueryClient } from "@tanstack/solid-query";
import { z } from "zod";
import { bulkQuery, runBatches, summarize, withoutIssues } from "../lib/bulk";
import { api } from "./instance";
import type { IssueFilter } from "./queries";
import { type IssueStatus, issueStatusSchema } from "./schemas";

type Pages = InfiniteData<{
  items: { id: string }[];
  next: string | undefined;
}>;
const enc = encodeURIComponent;

/**
 * Set the status of many issues of one project with
 * `PUT /projects/{org}/{project}/issues/?id=...&id=...`, at most 100 ids per request.
 *
 * The cached issue lists drop the issues at once when the new status no longer belongs on that
 * tab (the optimistic update). Batches that fail are rolled back from the snapshot taken before,
 * the others stay, and the lists are refetched either way. Returns what was updated and what not.
 */
export async function bulkUpdateStatus(
  qc: QueryClient,
  org: string,
  project: string,
  ids: readonly string[],
  status: IssueStatus,
) {
  const prefix = ["issues", org, project] as const;
  await qc.cancelQueries({ queryKey: prefix });
  const snapshot = qc.getQueriesData<Pages>({ queryKey: prefix });
  const leaves = (key: readonly unknown[]) =>
    (key[3] as IssueFilter | undefined)?.status !== status;
  const all = new Set(ids);
  for (const [key, data] of snapshot)
    if (data && leaves(key))
      qc.setQueryData<Pages>(key, withoutIssues(data, all));
  const results = await runBatches(ids, (batch) =>
    api.get(
      `/api/0/projects/${enc(org)}/${enc(project)}/issues/?${bulkQuery(batch)}`,
      z.object({ status: issueStatusSchema }).loose(),
      { method: "PUT", body: { status } },
    ),
  );
  const summary = summarize(results);
  if (summary.failed.length) {
    const done = new Set(summary.updated);
    for (const [key, data] of snapshot)
      if (data)
        qc.setQueryData<Pages>(
          key,
          leaves(key) ? withoutIssues(data, done) : data,
        );
  }
  void qc.invalidateQueries({ queryKey: ["issues"] });
  return summary;
}
