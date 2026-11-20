import type {
  ApiToken,
  ArchiveState,
  ArtifactBundle,
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
  putToken(token: ApiToken): Promise<void>;
}

export interface IssueRepo {
  get(projectId: ProjectId, issueId: IssueId): Promise<Issue | null>;
  /** Descending sort key, ascending issue ID tie-break; lastSeen uses [from, to).
   * Range with a non-lastSeen sort throws UnsupportedQueryError unless supported by capability.
   * Keysets do not provide a snapshot: changes crossing the cursor can be missed or repeated. */
  list(query: IssueQuery): Promise<Page<Issue>>;
  /** Subtract removedCount and repoint to newest remaining active event; if none remain, leave the previous pointer. */
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
  };

  get(projectId: ProjectId, eventId: EventId): Promise<StoredEvent | null>;
  /** Exclusive keyset after; order defaults to descending (receivedAt, eventId), range [from, to). */
  listByIssue(query: EventQuery): Promise<EventPage>;

  /** Ascending (receivedAt, eventId); cutoff is exclusive, with cursor and limit for paging. */
  scanOlderThan(
    projectId: ProjectId,
    cutoff: Timestamp,
    options?: { cursor?: Cursor; limit?: number },
  ): Promise<Page<StoredEvent>>;
  deleteBatch(projectId: ProjectId, ids: EventId[]): Promise<void>;
  /** Deletes at most limit matches with receivedAt <= before; repeat while hasMore. Returns
   * removed counts per issue and overflow blob keys so callers can clean up and repair. */
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
  putBundle(bundle: ArtifactBundle): Promise<void>;
  /** List bundles for a project and release. */
  listBundles(
    projectId: ProjectId,
    releaseId: ReleaseId,
    cursor?: Cursor,
    limit?: number,
  ): Promise<Page<ArtifactBundle>>;
  /** Delete a bundle; deleting a missing bundle is a no-op. */
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

export interface ActiveStore {
  /** Atomically insert the event and create/bump the issue; duplicate (projectId, eventId)
   * changes nothing. Use a SQL transaction, D1 batch, DynamoDB TransactWriteItems with
   * an event-item condition, or a Firestore transaction. Regression uses receivedAt;
   * latest event is the maximum (receivedAt, eventId). */
  recordEvent(
    occurrence: Occurrence,
    event: StoredEvent,
  ): Promise<{
    inserted: boolean;
    issue: Issue;
    isNew: boolean;
    isRegression: boolean;
  }>;
  projects: ProjectRepo;
  issues: IssueRepo;
  events: EventRepo;
  releases: ReleaseRepo;
  meta: MetaRepo;
  capabilities: {
    lastSeenRangeOnOtherSort: boolean;
    textSearch: boolean;
  };
  migrate(): Promise<void>;
}

export type Topic = string;

export interface Message {
  key: string;
  body: unknown;
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

/** Deliveries are at-least-once and unordered; handlers must be idempotent on the message key (eventId for event messages). */
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
}

/** Sources must match capabilities.delivery: push, pull, or both. */
export interface Queue<E = unknown, R = unknown> {
  producer: QueueProducer;
  capabilities: QueueCapabilities;
  pull?: PullSource;
  push?: PushSource<E, R>;
}

export interface BlobMetadata {
  size: number;
  contentType?: string;
}

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
