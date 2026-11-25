/** Opaque identifiers are serialized as strings at port boundaries. */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type OrgId = Brand<string, "OrgId">;

/** Decimal-digit project identifier, as required by Sentry DSNs. */
export type ProjectId = Brand<string, "ProjectId">;

export type ProjectKeyId = Brand<string, "ProjectKeyId">;

export type ApiTokenId = Brand<string, "ApiTokenId">;

/** Minted deterministically by core from (projectId, fingerprint). */
export type IssueId = Brand<string, "IssueId">;

export type EventId = Brand<string, "EventId">;

export type ReleaseId = Brand<string, "ReleaseId">;

export type ArtifactBundleId = Brand<string, "ArtifactBundleId">;

export type ErasureId = Brand<string, "ErasureId">;

/** UTC ISO 8601 with millisecond precision (Date.toISOString()), limited to four-digit years for lexical ordering. */
export type Timestamp = Brand<string, "Timestamp">;

export type Day = Brand<string, "Day">;

export type Cursor = Brand<string, "Cursor">;

/** Cursor advances past the last examined key, including filtered or stale entries.
 * A page may be empty with a continuation; null means the source is exhausted.
 * For merged streams it preserves each stream's consumed position, not prefetched rows. */
export interface Page<T> {
  items: T[];
  nextCursor: Cursor | null;
}

/** Exclusive key for merging active and archive pages. */
export interface EventPosition {
  receivedAt: Timestamp;
  eventId: EventId;
}

/** A page can be empty and still carry a continuation cursor. */
export interface EventPage {
  items: StoredEvent[];
  hasMore: boolean;
  nextCursor: Cursor | null;
}

export interface Org {
  id: OrgId;
  slug: string;
  name: string;
}

/**
 * Per-project rate rejection limits (counts only; the windows stay stack-wide). A project may
 * only tighten the stack's limits: a value above the stack's, or for a limit the stack leaves
 * disabled, is invalid. Absent fields leave the stack's limit in force.
 */
export interface ProjectRateLimits {
  /** Per-issue events per window; at most the stack's `issueRateLimit.events`. */
  issueEvents?: number;
  /** Candidate new issues per window; at most the stack's `newIssueCap.issues`. */
  newIssues?: number;
}

export interface Project {
  id: ProjectId;
  orgId: OrgId;
  slug: string;
  name: string;
  retentionDays: number;
  rateLimits?: ProjectRateLimits;
}

export interface ProjectKey {
  id: ProjectKeyId;
  projectId: ProjectId;
  publicKey: string;
  revokedAt?: Timestamp;
}

export interface ApiToken {
  id: ApiTokenId;
  orgId: OrgId;
  tokenHash: string;
  scopes: string[];
  /** Optional operator-facing label; never derived from the secret. */
  label?: string;
  /** Absent on tokens issued before M3 token management. */
  createdAt?: Timestamp;
  revokedAt?: Timestamp;
}

/** What token listings expose: metadata only, never the hash or plaintext. */
export type ApiTokenSummary = Omit<ApiToken, "tokenHash">;

export function summarizeApiToken(token: ApiToken): ApiTokenSummary {
  const { tokenHash: _hash, ...summary } = token;
  return summary;
}

export type IssueStatus = "unresolved" | "resolved" | "ignored";

export type EventLevel = "fatal" | "error" | "warning" | "info" | "debug";

export interface IssueDetails {
  title: string;
  culprit: string;
  level: EventLevel;
  type: string;
  metadata: Record<string, unknown>;
}

export interface Issue extends IssueDetails {
  id: IssueId;
  projectId: ProjectId;
  fingerprint: string;
  status: IssueStatus;
  resolvedAt?: Timestamp;
  firstSeen: Timestamp;
  lastSeen: Timestamp;
  /** Accepted event insertions ever recorded; retention and erasure never decrement it. */
  count: number;
  lastEventId: EventId;
  lastEventReceivedAt: Timestamp;
}

export interface Occurrence extends IssueDetails {
  issueId: IssueId;
  projectId: ProjectId;
  eventId: EventId;
  fingerprint: string;
  timestamp: Timestamp;
  receivedAt: Timestamp;
}

export interface StoredEvent {
  projectId: ProjectId;
  eventId: EventId;
  issueId: IssueId;
  timestamp: Timestamp;
  receivedAt: Timestamp;
  level: EventLevel;
  release?: string;
  environment?: string;
  tags: Record<string, string>;
  payload: Record<string, unknown>;
  payloadBlobKey?: string;
  /** Expiry is honored only by stores using the TTL delete strategy. */
  expiresAt?: Timestamp;
  user?: { id?: string; email?: string; username?: string; ipAddress?: string };
}

export interface ArchivedEvent extends StoredEvent {
  archiveBatch: string;
}

export interface Release {
  id: ReleaseId;
  projectId: ProjectId;
  version: string;
  createdAt: Timestamp;
  finalizedAt?: Timestamp;
}

export interface BundleManifest {
  blobKey: string;
  digest: string;
  debugIdCount: number;
}

export interface ArtifactBundle {
  id: ArtifactBundleId;
  projectId: ProjectId;
  releaseId: ReleaseId;
  blobKey: string;
  state: "pending" | "active";
  manifest: BundleManifest;
  pendingExpiresAt?: Timestamp;
  /** A cleanup claim blocks activation and marker writes until deletion is finished. */
  cleanupStarted?: boolean;
  cleanupMarkersCleared?: boolean;
  cleanupId?: string;
}

export type SubjectSelector =
  | { kind: "userId" | "email" | "username" | "ipAddress"; value: string }
  | { kind: "eventIds"; eventIds: EventId[] };

export type ErasureStatus =
  | "received"
  | "active-purged"
  | "archive-masked"
  | "archive-erased"
  | "done";

export type ErasureRequest = {
  id: ErasureId;
  projectId: ProjectId;
  version: number;
  requestedAt: Timestamp;
  stateChangedAt: Timestamp;
  maskSnapshotId?: string | null;
  rewriteSnapshotId?: string | null;
  filesBlobKey?: string;
} & (
  | { state: Exclude<ErasureStatus, "done">; selector: SubjectSelector }
  | { state: "done"; selectorHash: string; completedAt: Timestamp }
);

export interface ArchiveState {
  projectId: ProjectId;
  version: number;
  archivedThrough: Timestamp;
  seq: number;
  scanCursor?: Cursor;
  batch?: {
    id: string;
    /** `committing`: the archive append may or may not have happened (probe hasBatch). */
    state: "committing" | "committed";
    /** Blob listing the overflow payload keys of the batch rows, for the DELETE step. */
    overflowKey?: string;
    rowCount: number;
    dayRange: [Day, Day];
    maxReceivedAt: Timestamp;
  };
  lease?: { owner: string; until: Timestamp };
}

/** Validates the canonical UTC millisecond form. */
export function isTimestamp(value: string): value is Timestamp {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}
/** Convert a valid date to the canonical serialized representation. */
export function toTimestamp(date: Date): Timestamp {
  const value = date.toISOString();
  if (!isTimestamp(value))
    throw new RangeError("Timestamp outside canonical range");
  return value;
}
/** Parse only canonical timestamps. */
export function parseTimestamp(value: string): Timestamp {
  if (!isTimestamp(value)) throw new RangeError("Invalid timestamp");
  return value;
}
/** Sentry project IDs contain decimal digits only. */
export function isProjectId(value: string): value is ProjectId {
  return /^\d+$/.test(value);
}
