import type { Issue } from "@errtraq/core";
import { DynamoStoreError } from "./errors.js";
import { type Item, itemData, s } from "./repository-base.js";

/** Immutable fields remain in data; mutable fields live separately for narrow updates. */
export function issueFromItem(item: Item | undefined): Issue | null {
  const issue = itemData<Issue>(item);
  if (!issue || !item) return null;
  const status = item.issueStatus?.S;
  if (!status) return issue;
  if (status !== "unresolved" && status !== "resolved" && status !== "ignored")
    throw new DynamoStoreError("Invalid issue status");
  const count = Number(item.count?.N);
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !item.firstSeen?.S ||
    !item.lastSeen?.S ||
    !item.lastEventId?.S ||
    !item.lastEventReceivedAt?.S
  )
    throw new DynamoStoreError("Invalid issue item");
  return {
    ...issue,
    status,
    count,
    firstSeen: item.firstSeen.S as Issue["firstSeen"],
    lastSeen: item.lastSeen.S as Issue["lastSeen"],
    lastEventId: item.lastEventId.S as Issue["lastEventId"],
    lastEventReceivedAt: item.lastEventReceivedAt
      .S as Issue["lastEventReceivedAt"],
    resolvedAt: item.resolvedAt?.S as Issue["resolvedAt"],
  };
}
export function issueMutableAttributes(issue: Issue): Item {
  return {
    issueStatus: s(issue.status),
    firstSeen: s(issue.firstSeen),
    lastSeen: s(issue.lastSeen),
    lastEventId: s(issue.lastEventId),
    lastEventReceivedAt: s(issue.lastEventReceivedAt),
    ...(issue.resolvedAt ? { resolvedAt: s(issue.resolvedAt) } : {}),
  };
}
