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
  tags?: Record<string, string>;
  text?: string;
}

export interface EventQuery {
  projectId: ProjectId;
  issueId?: IssueId;
  from?: Timestamp;
  to?: Timestamp;
  cursor?: Cursor;
  limit?: number;
}

export interface ProjectRepo {
  getOrg(id: OrgId): Promise<Org | null>;
  putOrg(org: Org): Promise<void>;
  get(id: ProjectId): Promise<Project | null>;
  put(project: Project): Promise<void>;
  list(cursor?: Cursor): Promise<Page<Project>>;
  getKey(publicKey: string): Promise<ProjectKey | null>;
  putKey(key: ProjectKey): Promise<void>;
  getTokenByHash(tokenHash: string): Promise<ApiToken | null>;
  putToken(token: ApiToken): Promise<void>;
}

export interface IssueRepo {
  /** Atomically creates or updates the issue. */
  recordOccurrence(
    occurrence: Occurrence,
  ): Promise<{ issue: Issue; isNew: boolean; isRegression: boolean }>;
  get(projectId: ProjectId, issueId: IssueId): Promise<Issue | null>;
  list(query: IssueQuery): Promise<Page<Issue>>;
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

  /** Idempotent on (projectId, eventId). */
  put(event: StoredEvent): Promise<void>;
  get(projectId: ProjectId, eventId: EventId): Promise<StoredEvent | null>;
  listByIssue(query: EventQuery): Promise<Page<StoredEvent>>;

  /** Ordered by receivedAt and eventId. Cursor is needed by TTL stores. */
  scanOlderThan(
    projectId: ProjectId,
    cutoff: Timestamp,
    options?: { cursor?: Cursor; limit?: number },
  ): AsyncIterable<Page<StoredEvent>>;
  deleteBatch(projectId: ProjectId, ids: EventId[]): Promise<void>;
  deleteBySubject(
    projectId: ProjectId,
    selector: SubjectSelector,
    before: Timestamp,
  ): Promise<{ deleted: number; issueIds: IssueId[] }>;
}

export interface ReleaseRepo {
  get(projectId: ProjectId, id: ReleaseId): Promise<Release | null>;
  put(release: Release): Promise<void>;
  list(projectId: ProjectId, cursor?: Cursor): Promise<Page<Release>>;
  putBundle(bundle: ArtifactBundle): Promise<void>;
  findBundleByDebugId(
    projectId: ProjectId,
    debugId: string,
  ): Promise<ArtifactBundle | null>;
}

/** A null expected version creates a missing record; otherwise it must match exactly. */
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
  listErasureRequests(
    state: ErasureStatus,
    cursor?: Cursor,
  ): Promise<Page<ErasureRequest>>;
  compareAndSetErasureRequest(
    projectId: ProjectId,
    id: ErasureId,
    expectedVersion: number | null,
    next: ErasureRequest,
  ): Promise<void>;
}

export interface ActiveStore {
  projects: ProjectRepo;
  issues: IssueRepo;
  events: EventRepo;
  releases: ReleaseRepo;
  meta: MetaRepo;
  capabilities: {
    tagFilter: "any" | "indexed-only";
    textSearch: boolean;
    transactions: boolean;
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
  send(
    topic: Topic,
    messages: Message[],
    options?: { delaySec?: number },
  ): Promise<void>;
}

export interface PushSource<E, R = unknown> {
  toBatch(event: E): Delivery[];
  toResponse(result: BatchResult): R;
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
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<BlobMetadata | null>;
  list(prefix: string, cursor?: Cursor): Promise<Page<string>>;
  delete(key: string): Promise<void>;
  presign?(
    key: string,
    options: { method: "GET" | "PUT"; expiresInSec: number },
  ): Promise<string>;
}

export interface ArchiveStore {
  append(batch: {
    batchId: string;
    stagedKey: string;
    dayRange: [Day, Day];
  }): Promise<{ snapshotId: string; rowCount: number }>;
  hasBatch(batchId: string, dayRange: [Day, Day]): Promise<boolean>;
  query(query: EventQuery): Promise<Page<StoredEvent>>;
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
