import type { FunctionRole, PortKind, RoutedTopic } from "./stack-model.js";

export const QUEUE_CAPABILITIES = {
  producer: "produce",
  consumer: "consume",
} as const;

export interface PortRequirement {
  kind: PortKind;
  role: FunctionRole;
  capability: string;
  purpose: string;
  feature?:
    | "archive"
    | "notifications"
    | "direct"
    | "grouped"
    | "rate-api"
    | "rate-consumer"
    | "rate-record"
    | "rate-project"
    | "store-admin";
  milestone?: "M3" | "M4";
}
/** M1 calls are unconditional; M4 rows model the archive and erasure design. */
export const PORT_REQUIREMENTS: readonly PortRequirement[] = [
  { kind: "store", role: "ingest", capability: "key-read", purpose: "primary" },
  { kind: "store", role: "api", capability: "read", purpose: "primary" },
  { kind: "store", role: "api", capability: "write", purpose: "primary" },
  {
    kind: "store",
    role: "api",
    capability: "metadata-delete",
    purpose: "primary",
  },
  {
    kind: "blob",
    role: "api",
    capability: "write",
    purpose: "primary",
    milestone: "M3",
  },
  {
    kind: "blob",
    role: "api",
    capability: "delete",
    purpose: "primary",
    milestone: "M3",
  },
  {
    kind: "store",
    role: "consumer",
    capability: "read",
    purpose: "primary",
    feature: "direct",
  },
  {
    kind: "store",
    role: "consumer",
    capability: "write",
    purpose: "primary",
    feature: "direct",
  },
  {
    kind: "store",
    role: "record",
    capability: "read",
    purpose: "primary",
    feature: "grouped",
  },
  {
    kind: "store",
    role: "record",
    capability: "write",
    purpose: "primary",
    feature: "grouped",
  },
  {
    kind: "blob",
    role: "record",
    capability: "read",
    purpose: "primary",
    feature: "grouped",
  },
  {
    kind: "blob",
    role: "record",
    capability: "list",
    purpose: "primary",
    feature: "grouped",
  },
  { kind: "blob", role: "ingest", capability: "write", purpose: "primary" },
  { kind: "blob", role: "ingest", capability: "delete", purpose: "primary" },
  { kind: "blob", role: "api", capability: "read", purpose: "primary" },
  { kind: "blob", role: "consumer", capability: "read", purpose: "primary" },
  { kind: "blob", role: "consumer", capability: "write", purpose: "primary" },
  { kind: "blob", role: "consumer", capability: "delete", purpose: "primary" },
  // M3 deployed cron sweeps staged envelopes, including legacy keys that require reads.
  { kind: "blob", role: "cron", capability: "read", purpose: "primary" },
  { kind: "blob", role: "cron", capability: "list", purpose: "primary" },
  // M5b: the consumer resolves debug IDs to artifact bundles (`release-read`: DEBUG and BUNDLE
  // items only) and reads the bundle blobs it already may read. Direct mode already holds `read`.
  {
    kind: "store",
    role: "consumer",
    capability: "release-read",
    purpose: "primary",
    feature: "grouped",
  },
  // M5b: `bundle-cleanup` lists projects and pending bundles (read), moves the cleanup claim
  // (write), removes ownership markers and the bundle row (metadata-delete), and deletes the
  // bundle and manifest blobs.
  ...(["read", "write", "metadata-delete"] as const).map((capability) => ({
    kind: "store" as const,
    role: "cron" as const,
    capability,
    purpose: "primary",
  })),
  { kind: "blob", role: "cron", capability: "delete", purpose: "primary" },
  // `bundle-cleanup` persists its project cursor as one small blob (`cron/bundle-cleanup-cursor`).
  // Blob write rather than KV read and write: one policy instead of two, which keeps the
  // per-topic cron role under the inline policy budget.
  { kind: "blob", role: "cron", capability: "write", purpose: "primary" },
  { kind: "kv", role: "ingest", capability: "read", purpose: "primary" },
  { kind: "kv", role: "ingest", capability: "write", purpose: "primary" },
  {
    kind: "kv",
    role: "api",
    capability: "read",
    purpose: "primary",
    feature: "rate-api",
  },
  ...(["read", "write"] as const).flatMap((capability) =>
    (["consumer", "record"] as const).map((role) => ({
      kind: "kv" as const,
      role,
      capability,
      purpose: "primary",
      feature:
        role === "consumer"
          ? ("rate-consumer" as const)
          : ("rate-record" as const),
    })),
  ),
  // The grouped consumer resolves per-project issue limits; direct mode already has store read.
  {
    kind: "store",
    role: "consumer",
    capability: "project-read",
    purpose: "primary",
    feature: "rate-project",
  },
  // The optional bootstrap role migrates the store and creates the first organization, project,
  // key and token through ordinary repository calls, so it needs the store and KV read and write
  // access the API and ingest roles already use (project ID allocation is a KV counter).
  ...(["store", "kv"] as const).flatMap((kind) =>
    (["read", "write"] as const).map((capability) => ({
      kind,
      role: "bootstrap" as const,
      capability,
      purpose: "primary",
    })),
  ),
  // Database administration (creating the runtime database user) is delivered by a store's
  // `admin` capability, a secret binding only: no runtime role has this row.
  {
    kind: "store",
    role: "bootstrap",
    capability: "admin",
    purpose: "primary",
    feature: "store-admin",
  },
  // TODO(M4): archive workers, erasure suppression, and archive-aware queries.
  ...(["consumer", "cron"] as const).flatMap((role) => [
    ...(["read", "write", "delete"] as const).map((capability) => ({
      kind: "store" as const,
      role,
      capability,
      purpose: "primary",
      feature: "archive" as const,
      milestone: "M4" as const,
    })),
    ...(["read", "write", "delete", "list"] as const).map((capability) => ({
      kind: "blob" as const,
      role,
      capability,
      purpose: "staging",
      feature: "archive" as const,
      milestone: "M4" as const,
    })),
    ...(["read", "delete"] as const).map((capability) => ({
      kind: "blob" as const,
      role,
      capability,
      purpose: "primary",
      feature: "archive" as const,
      milestone: "M4" as const,
    })),
    ...(["read", "write", "delete"] as const).map((capability) => ({
      kind: "archive" as const,
      role,
      capability,
      purpose: "primary",
      feature: "archive" as const,
      milestone: "M4" as const,
    })),
  ]),
  {
    kind: "archive",
    role: "api",
    capability: "read",
    purpose: "primary",
    feature: "archive",
    milestone: "M4",
  },
  {
    kind: "kv",
    role: "consumer",
    capability: "read",
    purpose: "primary",
    feature: "archive",
    milestone: "M4",
  },
  {
    kind: "kv",
    role: "cron",
    capability: "write",
    purpose: "primary",
    feature: "archive",
    milestone: "M4",
  },
];

/** Routing is core-owned; the adapter maps only topics to physical resources. */
export const TOPIC_ROUTES: Readonly<
  Record<
    RoutedTopic,
    {
      producers: readonly FunctionRole[];
      consumer: FunctionRole;
      milestone?: "M4";
      feature?: "archive" | "notifications" | "direct" | "grouped";
    }
  >
> = {
  record: { producers: ["consumer"], consumer: "record", feature: "grouped" },
  ingest: { producers: ["ingest", "cron"], consumer: "consumer" },
  "archive.project": {
    producers: ["cron", "consumer"],
    consumer: "consumer",
    milestone: "M4",
    feature: "archive",
  },
  notifications: {
    producers: ["consumer"],
    consumer: "consumer",
    milestone: "M4",
    feature: "notifications",
  },
};
