/** Opaque identifiers are serialized as strings at port boundaries. */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type OrgId = Brand<string, "OrgId">;

export type ProjectId = Brand<string, "ProjectId">;

export type ProjectKeyId = Brand<string, "ProjectKeyId">;

export type ApiTokenId = Brand<string, "ApiTokenId">;

export type IssueId = Brand<string, "IssueId">;

export type EventId = Brand<string, "EventId">;

export type ReleaseId = Brand<string, "ReleaseId">;

export type ArtifactBundleId = Brand<string, "ArtifactBundleId">;

export type ErasureId = Brand<string, "ErasureId">;

/** UTC ISO 8601 instant and ISO calendar day, respectively. */
export type Timestamp = Brand<string, "Timestamp">;

export type Day = Brand<string, "Day">;

export type Cursor = Brand<string, "Cursor">;

export interface Page<T> {
  items: T[];
  nextCursor: Cursor | null;
}

export interface FederatedCursor {
  active: Cursor | null;
  archive: Cursor | null;
}

export interface Org {
  id: OrgId;
  slug: string;
  name: string;
}

export interface Project {
  id: ProjectId;
  orgId: OrgId;
  slug: string;
  name: string;
  retentionDays: number;
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
  revokedAt?: Timestamp;
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
  count: number;
  lastEventId: EventId;
  lastEventReceivedAt: Timestamp;
}

export interface Occurrence extends IssueDetails {
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

export interface ArtifactBundle {
  id: ArtifactBundleId;
  projectId: ProjectId;
  releaseId: ReleaseId;
  blobKey: string;
  debugIds: string[];
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
  snapshotId?: string | null;
  files?: string[];
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
    state: "staged" | "committed";
    stagedKey: string;
    rowCount: number;
    dayRange: [Day, Day];
    maxReceivedAt: Timestamp;
  };
  lease?: { owner: string; until: Timestamp };
}
