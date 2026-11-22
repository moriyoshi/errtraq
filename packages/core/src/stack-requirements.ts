import type {
  RoutedTopic as CoreTopic,
  FunctionRole,
  PortKind,
} from "./stack-model.js";

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
    | "rate-consumer"
    | "rate-record";
  milestone?: "M3" | "M4";
}
/** M1 calls are unconditional; M4 rows model the archive and erasure design. */
export const PORT_REQUIREMENTS: readonly PortRequirement[] = [
  { kind: "store", role: "ingest", capability: "read", purpose: "primary" },
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
  { kind: "kv", role: "ingest", capability: "read", purpose: "primary" },
  { kind: "kv", role: "ingest", capability: "write", purpose: "primary" },
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
    CoreTopic,
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
