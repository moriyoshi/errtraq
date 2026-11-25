/**
 * Declarative Firestore index configuration, the single source for both the Terraform module
 * (`infra/modules/gcp/firestore`, built in G6) and the offline coverage test. Single-field
 * indexes are automatic; only the composite indexes below and the single-field exemptions are
 * declared. Collection scope: a per-project subcollection named `issues` is covered by an
 * index on the collection id `issues`.
 */
import type { CompositeIndex } from "@moriyoshi/errtraq-firestore-rest";

const asc = (field: string) => ({ field, direction: "ASC" as const });
const desc = (field: string) => ({ field, direction: "DESC" as const });
const name = (direction: "ASC" | "DESC") => ({
  field: "__name__",
  direction,
});

const ISSUE_SORTS = ["lastSeen", "firstSeen", "count"] as const;

export const compositeIndexes: readonly CompositeIndex[] = [
  // issues.list: descending sort field with ascending issue ID tie break, optionally by status
  ...ISSUE_SORTS.flatMap((sort) => [
    { collection: "issues", fields: [asc("status"), desc(sort), name("ASC")] },
    { collection: "issues", fields: [desc(sort), name("ASC")] },
  ]),
  // events.listByIssue: the keyset (receivedAt, eventId) in either direction, per issue
  {
    collection: "events",
    fields: [asc("issueId"), asc("receivedAt"), name("ASC")],
  },
  {
    collection: "events",
    fields: [asc("issueId"), desc("receivedAt"), name("DESC")],
  },
  // releases.listPendingBundles
  {
    collection: "bundles",
    fields: [asc("state"), asc("pendingExpiresAt"), name("ASC")],
  },
  // projects.listTokens: tokens of one organization ordered by token ID
  { collection: "tokens", fields: [asc("orgId"), asc("id"), name("ASC")] },
  // meta.listErasureRequests filtered by both project and state
  {
    collection: "erasures",
    fields: [asc("projectId"), asc("state"), name("ASC")],
  },
];

/**
 * Fields exempt from the automatic single-field index: JSON bodies and payload bytes are never
 * queried, and indexed strings over 1,500 bytes are truncated by Firestore. No query may filter
 * or order on these (the coverage test enforces it).
 */
export const fieldExemptions: readonly { collection: string; field: string }[] =
  [
    "orgs",
    "projects",
    "keys",
    "tokens",
    "issues",
    "events",
    "releases",
    "bundles",
    "erasures",
    "meta",
  ].flatMap((collection) => [
    { collection, field: "data" },
    ...(collection === "events" ? [{ collection, field: "payload" }] : []),
  ]);

/** Terraform's vocabulary (`google_firestore_index` fields), the shape G6 consumes. */
export function terraformIndexes() {
  const order = (d: "ASC" | "DESC") =>
    d === "ASC" ? "ASCENDING" : "DESCENDING";
  return compositeIndexes.map((index) => ({
    collection: index.collection,
    fields: index.fields
      // `__name__` is implicit in Terraform; the direction follows the last explicit field.
      .filter((f) => f.field !== "__name__")
      .map((f) => ({ field_path: f.field, order: order(f.direction) })),
  }));
}
