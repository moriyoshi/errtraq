import type {
  ApiToken,
  ApiTokenId,
  ApiTokenSummary,
  ArchiveState,
  ArtifactBundle,
  BundleManifest,
  Cursor,
  Day,
  ErasureId,
  ErasureRequest,
  ErasureStatus,
  EventId,
  EventPage,
  EventPosition,
  Issue,
  IssueId,
  IssueStatus,
  Occurrence,
  Org,
  OrgId,
  Page,
  Project,
  ProjectId,
  ProjectKey,
  Release,
  ReleaseId,
  StoredEvent,
  SubjectSelector,
  Timestamp,
} from "./domain.js";
import type { FunctionRole } from "./stack.js";

export interface IssueQuery {
  projectId: ProjectId;
  status?: IssueStatus;
  from?: Timestamp;
  to?: Timestamp;
  sort: "lastSeen" | "firstSeen" | "count";
  cursor?: Cursor;
  limit?: number;
  text?: string;
}

export interface EventQuery {
  projectId: ProjectId;
  issueId?: IssueId;
  from?: Timestamp;
  to?: Timestamp;
  /** Source-local examined-key cursor; independent of the federation after position. */
  cursor?: Cursor;
  after?: EventPosition;
  order?: "asc" | "desc";
  limit?: number;
}

/** Puts update the same ID; a natural key owned by another ID raises ConflictError. */
export interface ProjectRepo {
  getOrg(id: OrgId): Promise<Org | null>;
  /** Lookup organization by its slug. */
  getOrgBySlug(slug: string): Promise<Org | null>;
  putOrg(org: Org): Promise<void>;
  get(id: ProjectId): Promise<Project | null>;
  /** Lookup within the given organization. */
  getProjectBySlug(orgId: OrgId, slug: string): Promise<Project | null>;
  put(project: Project): Promise<void>;
  list(cursor?: Cursor, limit?: number): Promise<Page<Project>>;
  getKey(publicKey: string): Promise<ProjectKey | null>;
  putKey(key: ProjectKey): Promise<void>;
  /** Atomically return an existing active key for the project or create and return the supplied key. */
  getOrCreateActiveKey(key: ProjectKey): Promise<ProjectKey>;
  /** List keys belonging to a project. */
  listKeys(projectId: ProjectId): Promise<ProjectKey[]>;
  getTokenByHash(tokenHash: string): Promise<ApiToken | null>;
  /** Atomically insert only when its hash is absent; return false for an existing hash.
   * Never modify an existing token. A token ID owned by a different hash raises ConflictError. */
  createToken(token: ApiToken): Promise<boolean>;
  putToken(token: ApiToken): Promise<void>;
  /** Indexed, paged token metadata for one organization, ascending by token ID. Never returns
   * hashes. Tokens written before the index existed are listed once any putToken (or
   * revokeToken) rewrites them; SQL adapters backfill in migration. Cursors advance over
   * examined index keys, so a page may be short. */
  listTokens(
    orgId: OrgId,
    cursor?: Cursor,
    limit?: number,
  ): Promise<Page<ApiTokenSummary>>;
  /** Idempotent revocation scoped to the organization. Returns the resulting summary, or null
   * when no such token exists in that organization. An already revoked token keeps its first
   * revokedAt. The revoked state is visible to getTokenByHash immediately (read-after-write). */
  revokeToken(
    orgId: OrgId,
    id: ApiTokenId,
    at: Timestamp,
  ): Promise<ApiTokenSummary | null>;
}

export interface IssueRepo {
  /** Look up issue IDs across projects using an index; callers must apply organization access checks. */
  getById(issueId: IssueId): Promise<Issue[]>;
  /** Read the latest committed issue, with read-after-write consistency. */
  get(projectId: ProjectId, issueId: IssueId): Promise<Issue | null>;
  /** Descending sort key, ascending issue ID tie-break; lastSeen uses [from, to).
   * Range with a non-lastSeen sort throws UnsupportedQueryError unless supported by capability.
   * Keysets do not provide a snapshot: changes crossing the cursor can be missed or repeated. */
  list(query: IssueQuery): Promise<Page<Issue>>;
  /** Unavailable until the M4 subject index; always throws UnsupportedQueryError. */
  repairAfterErasure(
    projectId: ProjectId,
    issueId: IssueId,
    removedCount: number,
  ): Promise<Issue>;
  /** Throws NotFoundError if the project/issue pair is absent. */
  update(
    projectId: ProjectId,
    issueId: IssueId,
    patch: Partial<Pick<Issue, "status" | "resolvedAt">>,
  ): Promise<Issue>;
}

export interface EventRepo {
  readonly capabilities: {
    deleteStrategy: "explicit" | "ttl";
    /** Subject erasure requires the M4 SubjectIndex and is unavailable in stage 1. */
    deleteBySubject: false;
  };

  get(projectId: ProjectId, eventId: EventId): Promise<StoredEvent | null>;
  /** Exclusive federation keyset after; order defaults to descending (receivedAt, eventId), range [from, to).
   * The independent cursor advances by examined source keys, including stale rows; empty pages can continue. */
  listByIssue(query: EventQuery): Promise<EventPage>;

  /** Ascending (receivedAt, eventId); cutoff is exclusive, with cursor and limit for paging. */
  scanOlderThan(
    projectId: ProjectId,
    cutoff: Timestamp,
    options?: { cursor?: Cursor; limit?: number },
  ): Promise<Page<StoredEvent>>;
  deleteBatch(projectId: ProjectId, ids: EventId[]): Promise<void>;
  /** Unavailable until the M4 subject index; always throws UnsupportedQueryError. */
  deleteBySubject(
    projectId: ProjectId,
    selector: SubjectSelector,
    before: Timestamp,
    limit: number,
  ): Promise<{
    deleted: number;
    hasMore: boolean;
    issueCounts: Array<{ issueId: IssueId; count: number }>;
    payloadBlobKeys: string[];
  }>;
}

/** A release version already owned by another ID raises ConflictError. */
export interface ReleaseRepo {
  get(projectId: ProjectId, id: ReleaseId): Promise<Release | null>;
  put(release: Release): Promise<void>;
  /** Lookup a release by version within a project. */
  getReleaseByVersion(
    projectId: ProjectId,
    version: string,
  ): Promise<Release | null>;
  list(
    projectId: ProjectId,
    cursor?: Cursor,
    limit?: number,
  ): Promise<Page<Release>>;
  /** Begin or retry an identical pending bundle; competing IDs are rejected. */
  beginBundle(bundle: ArtifactBundle, manifest: BundleManifest): Promise<void>;
  /** Claim at most 100 IDs from the verified immutable manifest. A debug ID has one owner per project. */
  putBundleDebugIds(
    projectId: ProjectId,
    bundleId: ArtifactBundle["id"],
    debugIds: readonly string[],
    manifestIds: readonly string[],
  ): Promise<void>;
  /** Caller loads the immutable manifest from BlobStore and supplies its IDs for verification. */
  verifyAndActivateBundle(
    projectId: ProjectId,
    bundleId: ArtifactBundle["id"],
    debugIds: readonly string[],
  ): Promise<void>;
  /** List expired pending bundles for cleanup; caller removes each manifest after deleting its markers. */
  listPendingBundles(
    projectId: ProjectId,
    before: Timestamp,
    cursor?: Cursor,
    limit?: number,
  ): Promise<Page<ArtifactBundle>>;
  /** Atomically claim an expired pending bundle; null means missing, active or not expired.
   * Clear markers, delete the manifest, then finish the claim; interrupted claims remain listed. */
  claimPendingBundleCleanup(
    projectId: ProjectId,
    bundleId: ArtifactBundle["id"],
    before: Timestamp,
  ): Promise<ArtifactBundle | null>;
  /** After claiming cleanup, remove this bundle's markers in retryable bounded chunks, then persist completion. */
  clearPendingBundleDebugIds(
    projectId: ProjectId,
    bundleId: ArtifactBundle["id"],
    debugIds: readonly string[],
    cleanupId: string,
  ): Promise<void>;
  /** Finalize only the matching cleanup claim. */
  finishPendingBundleCleanup(
    projectId: ProjectId,
    bundleId: ArtifactBundle["id"],
    cleanupId: string,
  ): Promise<void>;
  /** List bundles for a project and release. */
  listBundles(
    projectId: ProjectId,
    releaseId: ReleaseId,
    cursor?: Cursor,
    limit?: number,
  ): Promise<Page<ArtifactBundle>>;
  /** Delete an active bundle; missing is a no-op. Pending bundles use the cleanup protocol. */
  deleteBundle(
    projectId: ProjectId,
    bundleId: ArtifactBundle["id"],
  ): Promise<void>;
  findBundleByDebugId(
    projectId: ProjectId,
    debugId: string,
  ): Promise<ArtifactBundle | null>;
}

/** CAS creates at version 0 with expected null; updates require next.version = expected + 1.
 * A missing record or mismatched expected version raises VersionConflictError. */
export interface MetaRepo {
  getArchiveState(projectId: ProjectId): Promise<ArchiveState | null>;
  compareAndSetArchiveState(
    projectId: ProjectId,
    expectedVersion: number | null,
    next: ArchiveState,
  ): Promise<void>;
  getErasureRequest(
    projectId: ProjectId,
    id: ErasureId,
  ): Promise<ErasureRequest | null>;
  /** Filter by project and/or state; state-only queries support cross-project cron work. */
  listErasureRequests(options: {
    projectId?: ProjectId;
    state?: ErasureStatus;
    cursor?: Cursor;
    limit?: number;
  }): Promise<Page<ErasureRequest>>;
  compareAndSetErasureRequest(
    projectId: ProjectId,
    id: ErasureId,
    expectedVersion: number | null,
    next: ErasureRequest,
  ): Promise<void>;
}

export interface RecordInput {
  occurrence: Occurrence;
  event: StoredEvent;
}
export interface RecordResult {
  inserted: boolean;
  issue: Issue;
  isNew: boolean;
  isRegression: boolean;
}
export interface ActiveStore {
  /** Atomically insert the event and create/bump the issue; duplicate (projectId, eventId)
   * changes nothing. Use a SQL transaction, D1 batch, DynamoDB TransactWriteItems with
   * an event-item condition, or a Firestore transaction. Regression uses receivedAt;
   * latest event is the maximum (receivedAt, eventId). */
  recordEvent(
    occurrence: Occurrence,
    event: StoredEvent,
  ): Promise<RecordResult>;
  /** Atomically record 1..10 events for one project, issue and fingerprint.
   * Results follow input order; duplicate IDs are no-ops. All new events commit
   * together or none do, except an ambiguous response may require a retry.
   * Adapters declaring recordEvents false reject this operation. */
  recordEvents(group: readonly RecordInput[]): Promise<readonly RecordResult[]>;
  projects: ProjectRepo;
  issues: IssueRepo;
  events: EventRepo;
  releases: ReleaseRepo;
  meta: MetaRepo;
  capabilities: {
    lastSeenRangeOnOtherSort: boolean;
    textSearch: boolean;
    /** Whether atomic grouped recording is supported. */
    recordEvents: boolean;
  };
  migrate(): Promise<void>;
}

export type Topic = string;

/** Body must be plain JSON data: null, booleans, finite numbers, strings, arrays and plain objects. */
export interface Message {
  key: string;
  body: unknown;
  /** Ordered delivery key; required for a topic using grouped delivery. */
  groupKey?: string;
}

export interface Delivery {
  id: string;
  topic: Topic;
  message: Message;
  attempt: number;
}

export type BatchResult = Array<
  | { deliveryId: string; action: "ack" }
  | { deliveryId: string; action: "retry"; delaySec?: number }
>;

/** Deliveries are at-least-once. Grouped queues preserve acceptance order per
 * key and do not intentionally dispatch another batch for a key while its lease
 * is live. Lease expiry, retries and redelivery can overlap: this is not a lock.
 * Different groups can run concurrently. Handlers must be idempotent and must
 * stop processing a FIFO group after its first failure, returning retries for
 * that delivery and every later unprocessed delivery in the group. */
export type BatchHandler = (batch: Delivery[]) => Promise<BatchResult>;

export interface QueueProducer {
  /** Validate the whole batch before publishing; delaySec must be finite and non-negative. */
  send(
    topic: Topic,
    messages: Message[],
    options?: { delaySec?: number },
  ): Promise<void>;
}

export interface PushSource<E, R = unknown> {
  /** Converts and handles the platform event, applying per-message ack/retry asynchronously. */
  handle(event: E, handler: BatchHandler): Promise<R>;
}

export interface PullSource {
  run(handler: BatchHandler, signal: AbortSignal): Promise<void>;
}

export interface QueueCapabilities {
  delivery: "push" | "pull" | "both";
  maxBytes: number;
  delay: boolean;
  dlq: boolean;
  /** Explicit support for per-key serial delivery. */
  grouping: "per-key-serial" | "none";
  /** Physical queues may differ, notably FIFO queues without per-message delay. */
  physicalQueues?: Readonly<
    Record<string, { grouping: "per-key-serial" | "none"; delay: boolean }>
  >;
}

/** Sources must match capabilities.delivery: push, pull, or both. */
export interface Queue<E = unknown, R = unknown> {
  /** Optional local observation for bounded graceful shutdown; true only when no messages are pending or in flight. */
  idle?(): Promise<boolean>;
  producer: QueueProducer;
  capabilities: QueueCapabilities;
  pull?: PullSource;
  push?: PushSource<E, R>;
}

export interface BlobMetadata {
  size: number;
  contentType?: string;
}

/** Blob keys are nonempty, at most 1024 UTF-8 bytes, contain no control characters,
 * and contain no `.` or `..` path segments. Invalid keys raise BlobInvalidKeyError.
 * Read capability includes prefix-scoped listing for missing-key disambiguation. */
export interface BlobStore {
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    metadata?: { contentType?: string; size?: number },
  ): Promise<void>;
  /** Optional byte range starts at offset and spans at most length bytes. Corrupt data raises BlobCorruptError. */
  get(
    key: string,
    options?: { range?: { offset: number; length?: number } },
  ): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<BlobMetadata | null>;
  /** Keys matching prefix in ascending UTF-8 byte order; cursor and limits are validated. */
  list(prefix: string, cursor?: Cursor, limit?: number): Promise<Page<string>>;
  delete(key: string): Promise<void>;
  presign?(
    key: string,
    options: { method: "GET" | "PUT"; expiresInSec: number },
  ): Promise<string>;
}

export interface ArchiveStore {
  /** Repeating a batchId is safe and must not append its rows twice. */
  append(batch: {
    batchId: string;
    stagedKey: string;
    dayRange: [Day, Day];
  }): Promise<{ snapshotId: string; rowCount: number }>;
  hasBatch(batchId: string, dayRange: [Day, Day]): Promise<boolean>;
  /** Same exclusive keyset and ordering as EventRepo.listByIssue. */
  query(query: EventQuery): Promise<EventPage>;
  getEvent(
    projectId: ProjectId,
    eventId: EventId,
    hintTs?: Timestamp,
  ): Promise<StoredEvent | null>;
  deleteWhere(request: {
    erasureId: ErasureId;
    projectId: ProjectId;
    selector: SubjectSelector;
  }): Promise<{
    snapshotId: string | null;
    rowsDeleted: number;
    files: string[];
  }>;
  hardErase(request: {
    erasureId: ErasureId;
    files: string[];
  }): Promise<{ snapshotId: string }>;
  expireSnapshots(olderThan: Timestamp): Promise<void>;
  capabilities: {
    rowDelete: "deletion-vector" | "position-delete" | "copy-on-write";
  };
}

export interface KV {
  /** Atomically add by and return the new safe integer; TTL applies on creation.
   * Existing values must match /^-?\d+$/ and fit a safe integer, otherwise InvalidCounterError. */
  increment(
    key: string,
    by: number,
    options?: { ttlSec?: number },
  ): Promise<number>;
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { ttlSec?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CronJob {
  name: string;
  schedule: string;
  role: FunctionRole;
}

export type CronHandler = (name: string, firedAt: Timestamp) => Promise<void>;

export interface Clock {
  now(): Timestamp;
}

export interface IdGen {
  next(): string;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
/** Retrieves the value of an identifier held by an external secret store. */
export interface SecretSource {
  read(identifier: string): Promise<string>;
}
