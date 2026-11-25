# errtraq architecture

## Context

errtraq is a Sentry-SDK-compatible error tracker (in the spirit of GlitchTip and Bugsink) whose
whole stack runs on serverless platforms (Lambda, Cloud Run, Cloudflare, Vercel) and also as a
local standalone process. Storage, queue, archive and compute are all pluggable, and the same
stack description that selects the runtime adapters also generates the Terraform that
provisions them.

Founding decisions:

- **Language:** TypeScript (the only candidate that runs natively on every listed target).
- **Iceberg catalog:** talk the **Iceberg REST Catalog** protocol so Lakekeeper works, as do
  S3 Tables / Glue REST / R2 Data Catalog / Polaris.
- **First cloud targets:** AWS first, then Cloudflare. Local standalone before both.
- **IaC:** an abstraction layer that *generates* a Terraform root (module composition + tfvars)
  from the stack configuration; hand-written HCL modules underneath.
- **Sentry scope:** error events + releases/sourcemaps (sentry-cli compatible). Transactions,
  replays, profiles, sessions are accepted and dropped.

The layered service abstractions and the infra abstraction come first: milestones M0 to M2
below are the first implementation round; M3 onwards is the roadmap.

## Layering

```
L4  Entrypoints      lambda handler | worker fetch/queue/scheduled | node server (standalone) | cloud run
L3  Apps (Hono)      ingest app | api app | queue-consumer | cron jobs      (Web-standard Request/Response)
L2  Core services    Ingest, Normalize, Grouping, Symbolication, IssueQuery, EventQuery(federated), Archival, Retention
L1  Ports            ActiveStore, Queue, BlobStore, ArchiveStore, KV, Clock/Id/Logger (+ a static cron job table)
L0  Adapters         sqlite/pg/mysql/d1/libsql/dynamodb/firestore · memory/sqs/cf-queues/redis/nats/pubsub/... · fs/s3/r2/gcs/azure · iceberg-rest
```

Rules: `core` depends only on ports and Web-standard APIs (fetch, WebCrypto, streams) — no
`node:*` imports — so it bundles for Workers. Adapters depend on core, never on each other.
Entrypoints are generated per stack and statically import only the selected adapters
(bundle size on Workers/Lambda, no dynamic `require`).

## Repository layout (pnpm workspace)

```
packages/
  core/            domain types, ports, services, stack-config schema (zod)
  http/            Hono apps: ingest, api (Sentry-compatible subset), consumer + cron handlers
  testing/         port contract test suites + fakes (vitest)
  cli/             `errtraq` CLI: dev, build, infra generate, migrate
  infra-gen/       stack config -> Terraform root (main.tf.json + tfvars.json)
  adapters/
    store-sql/     Kysely-based shared impl; dialects: sqlite, postgres(+supabase), mysql, d1, libsql(turso)
    store-dynamodb/  store-firestore/
    queue-memory/ queue-sqs/ queue-cf/ queue-redis/ queue-nats/ queue-pubsub/ queue-cloudtasks/ queue-servicebus/
    blob-fs/ blob-s3/ (S3, R2, winterbaume, GCS-interop) blob-r2-binding/ blob-gcs/ blob-azure/
    archive-iceberg/   REST catalog client + writer/query engines
  platforms/
    standalone/ aws-lambda/ cloudflare/ cloud-run/ vercel/     entrypoint templates + compute infra descriptor
infra/modules/<provider>/<component>/     hand-written HCL modules (aws/sqs, aws/dynamodb, aws/lambda-app, cloudflare/d1, ...)
stacks/            example stack configs: local.ts, aws-dynamodb.ts, aws-postgres.ts, cloudflare.ts
docker/            compose for conformance deps: postgres, mysql, winterbaume (AWS emulator: S3 — see note below), lakekeeper, dynamodb-local, elasticmq, redis, nats
```

## Ports (L1) — the key design choices

### ActiveStore — repository-level, not SQL-level
SQL and DynamoDB/Firestore cannot share a query abstraction, so the port is a set of
access-pattern-shaped repositories; each adapter implements them natively.

The sketches below are abridged; `packages/core/src/ports.ts` and `domain.ts` are authoritative
and carry the exact ordering, range and atomicity rules as JSDoc.

```ts
interface ActiveStore {
  // The only write path for an event. Atomically inserts the event (keyed by projectId + eventId)
  // and creates or bumps its issue; a duplicate eventId changes nothing. SQL: transaction; D1: batch;
  // DynamoDB: TransactWriteItems with a condition on the event item; Firestore: transaction.
  recordEvent(o: Occurrence, e: StoredEvent): Promise<{ inserted: boolean; issue: Issue; isNew: boolean; isRegression: boolean }>;
  projects: ProjectRepo;      // orgs, projects (listByOrg), DSN keys, API tokens; lookups by id and by slug
  issues: IssueRepo;
  events: EventRepo;
  releases: ReleaseRepo;      // releases (by id and version), artifact bundles, debug-id index
  meta: MetaRepo;             // ArchiveState and ErasureRequest records, compare-and-set on version
  capabilities: { textSearch: boolean; lastSeenRangeOnOtherSort: boolean };
  migrate(): Promise<void>;
}
// ProjectRepo.createToken inserts only when the token hash is absent; it never revives a token.
// ProjectRepo.listTokens (per organization, paged, metadata only) and revokeToken (idempotent,
// organization-scoped, read-after-write) back the operator `errtraq token list|revoke` commands.
interface IssueRepo {
  get(projectId, issueId): Promise<Issue | null>;
  list(q: IssueQuery): Promise<Page<Issue>>;   // project, status, [from, to) on lastSeen, sort ∈ {lastSeen, firstSeen, count} descending, cursor
  update(projectId, issueId, patch): Promise<Issue>;
  repairAfterErasure(...): Promise<Issue>;   // unavailable until M4; no count-decrement path
}
interface EventRepo {
  capabilities: { deleteStrategy: 'explicit' | 'ttl'; deleteBySubject: false };
  get(projectId, eventId): Promise<StoredEvent | null>;
  listByIssue(q: EventQuery): Promise<EventPage>;                          // keyset paging, see Federation
  scanOlderThan(projectId, cutoff, { cursor?, limit? }): Promise<Page<StoredEvent>>;   // archival source, ascending, cutoff exclusive
  deleteBatch(projectId, ids): Promise<void>;
  deleteBySubject(...): Promise<{ deleted; hasMore; issueCounts; payloadBlobKeys }>; // always throws until M4
}
interface ReleaseRepo {
  getBundle(projectId, bundleId): Promise<ArtifactBundle | null>; // any state; lets a retry adopt the stored row
  beginBundle(bundle, manifest): Promise<void>; // pending with an expiry and immutable manifest reference
  putBundleDebugIds(projectId, bundleId, ids, manifestIds): Promise<void>; // <=100 verified IDs, exclusive ownership
  verifyAndActivateBundle(projectId, bundleId, ids): Promise<void>;
  findBundleByDebugId(projectId, debugId): Promise<ArtifactBundle | null>; // active only
  listPendingBundles(...): Promise<Page<ArtifactBundle>>;
  claimPendingBundleCleanup(...): Promise<ArtifactBundle | null>;
  clearPendingBundleDebugIds(...): Promise<void>;
  finishPendingBundleCleanup(...): Promise<void>;
  deleteBundle(projectId, bundleId): Promise<void>;
}
```

- A bundle manifest is a JSON array of distinct debug IDs, with a SHA-256 digest of the UTF-8 JSON
  array sorted in byte order. Manifest blob keys are immutable and must never be reused. Cleanup
  claims an expired pending bundle, clears markers, deletes the manifest and finalizes the claim;
  interrupted cleanup remains resumable. Pending bundle items and manifest chunks have no TTL;
  cleanup cron is required and operators must monitor its age and failures. SQL schema version 4
  marks legacy bundles active.
- An issue count is accepted event insertions ever recorded; deletion, retention and erasure do
  not decrement it. Event cursors advance by the last examined source key, even for an empty
  page, while the federation `after` boundary remains separate.
- **Issue ids are minted by core**, deterministically from `(projectId, fingerprint)`, so the
  id is known before any store call and `recordEvent` can be one conditional write on a
  key-value store. Project ids are decimal-digit strings, because Sentry SDKs reject DSNs whose
  project id is not numeric.
- `Timestamp` is always the canonical UTC millisecond form produced by `Date.toISOString()`;
  stores compare timestamps as strings.
- `IssueQuery` is deliberately the intersection that key-value stores can serve via GSIs /
  composite indexes; richer filters are gated on `capabilities` and rejected with a clear
  error (API returns 400 "not supported by this store") rather than silently table-scanning.
- All SQL engines share one implementation on **Kysely** (dialects exist for pg, mysql,
  sqlite, D1, libsql); only driver wiring + a few dialect quirks (upsert syntax, JSON columns)
  differ. Migrations written with Kysely's schema builder, run via `errtraq migrate` or on
  cold start for D1/SQLite.
- DynamoDB: one table with distributed `EV|project|eventId` event keys and
  `IS|project|issueId` issue keys, an issue-ID pointer, and eleven sparse keys-only GSIs.
  A durable table metadata item records the immutable project-time shard count. The
  Terraform module and M3e stage 1 runtime are implemented. See
  `.agents-docs/DYNAMODB_DESIGN.md`. Firestore: per-project subcollections + composite indexes.
- Event payloads above a size threshold (DynamoDB 400 KB, D1 row limits) overflow to BlobStore
  by reference — handled in core, not per adapter.

### Queue — unify push and pull delivery
```ts
interface Message  { key: string; body: unknown; groupKey?: string } // key = eventId for event messages
interface Delivery { id: string; topic: Topic; message: Message; attempt: number }
interface QueueProducer { send(topic: Topic, msgs: Message[], opts?: { delaySec?: number }): Promise<void>; }
type BatchHandler = (batch: Delivery[]) => Promise<BatchResult>;   // per-delivery ack | retry(delaySec)
interface PushSource<E, R> { handle(platformEvent: E, handler: BatchHandler): Promise<R>; }   // SQS event, CF MessageBatch, Pub/Sub push, Cloud Tasks HTTP
interface PullSource { run(handler: BatchHandler, signal: AbortSignal): Promise<void>; }      // memory, Redis streams, NATS JetStream, Service Bus
interface Queue { producer: QueueProducer; pull?: PullSource; push?: PushSource; capabilities: { delivery: 'push' | 'pull' | 'both'; maxBytes: number; delay: boolean; dlq: boolean; grouping: 'per-key-serial' | 'none' } }
```
- A push source owns the whole platform round trip (`handle`), because acknowledging is
  platform-specific and asynchronous: SQS retry delay is a `ChangeMessageVisibility` call,
  Cloudflare Queues ack / retry are methods on the original batch.
- Delivery is at-least-once; queues with grouped delivery preserve order per group during a
  live lease, with the visibility-timeout limits below. Other queues are unordered.
- Push sources are driven by the platform entrypoint; pull sources need a long-lived process
  (standalone / container). Stack validation rejects pull-only queue + function-only compute.
- **Claim-check**: ingest writes the raw envelope to BlobStore and enqueues a small reference,
  so every queue's size limit is irrelevant and ingest stays a fast, dumb path.

### BlobStore
`put / get (stream, optional byte range) / head / list(prefix, cursor, limit) / delete / presign?` — used for raw envelopes,
event payload overflow, sourcemap artifact bundles, and Iceberg data files. One `blob-s3`
adapter (aws4fetch-based, Workers-safe) covers S3, R2, winterbaume and GCS interop; native R2
binding, GCS and Azure adapters are thin additions.

### ArchiveStore — Iceberg over REST catalog
```ts
interface ArchiveStore {
  append(batch: { batchId: string; stagedKey: string; dayRange: [Day, Day] }): Promise<{ snapshotId: string; rowCount: number }>;
  hasBatch(batchId: string, dayRange: [Day, Day]): Promise<boolean>;   // idempotency probe, partition-pruned
  query(q: EventQuery): Promise<EventPage>;                                // same keyset paging as EventRepo.listByIssue
  getEvent(projectId, eventId, hintTs?): Promise<StoredEvent | null>;
  // erasure operations: see "End-user PII erasure"
}
```
- Table `events`, partitioned by `day(received_at)` only; every data file holds a single
  project (see archival job), so manifest column bounds on `project_id` prune per project
  without a projects×days partition explosion. Sorted by `issue_id, received_at`. Full event
  JSON in one column plus promoted columns (issue_id, level, release, environment, tags map,
  `archive_batch`).
- Catalog access is always the **Iceberg REST spec** (`IcebergRestCatalog` client: config,
  load table, commit, vended credentials) → Lakekeeper locally and self-hosted; S3 Tables /
  Glue REST on AWS; R2 Data Catalog on Cloudflare.
- Read/write *engine* is a sub-port because no mature pure-JS Iceberg writer exists:
  - `duckdb` engine (default for local + Lambda/Cloud Run): DuckDB iceberg extension attached to the REST catalog for both append and query.
  - No Athena engine: Athena cannot read format-v3 tables. On Cloudflare the catalog's SQL is read-only and no in-process write path is verified, so Workers stacks query over HTTP or delegate archive writes to a function that can run DuckDB.
  - **Spike results** (2026-11, see `.agents-docs/M4_ICEBERG_SPIKE_RESEARCH.md`, `DUCKDB_LAMBDA_SPIKE.md`, `S3TABLES_DV_SPIKE.md`): DuckDB 2.0 on S3 Tables creates v3 tables, appends, prunes the batch-id probe, and writes merged deletion vectors that other readers honor. It runs on Lambda (Node 22) best as a container image with the extensions baked in (cold start 1.2 to 2.3 s at 1024 MB; `home_directory` must point at `/tmp`). It cannot set snapshot summary properties, so append idempotency stays with the `archive_batch` column and pre-check. The adapter must set `iceberg_use_metadata_log = false` (a session otherwise does not see its own commits) and retry commit conflicts. Still open: Lakekeeper + winterbaume locally, and the physical-erasure path below.
- **Federation** (core `EventQueryService`): issues never leave the active store (small, mutable);
  only events are archived. `meta` holds a per-project `archivedThrough` watermark. The active
  store is **always** queried; the archive is queried additionally iff the range starts before
  the watermark. Both sources page by the same exclusive keyset, `EventQuery.after =
  { receivedAt, eventId }` with `order: 'asc' | 'desc'` (default newest first), and return
  `{ items, hasMore }`. The service merge-sorts the two pages, dedupes on eventId, emits `limit`
  rows, and resumes both sources from the last emitted key, so no row is skipped or repeated
  (opaque per-source cursors could not guarantee that). The watermark therefore only ever *skips the archive*, never the active store,
  so late or not-yet-deleted rows can't be missed. Details in "Archival job" below.

### Small ports
`KV` (rate limits via atomic `increment`, DSN-key cache, erasure suppression list; memory /
Redis / DynamoDB / CF KV), `Clock`, `IdGen`, `Logger`.

There is no scheduler port. On serverless platforms cron is declared in infrastructure and the
platform delivers ticks, so core exports a static job table (`CronJob { name; schedule }`) and a
`CronHandler (name, firedAt)`; the platform adapter turns the table into triggers (EventBridge,
CF Cron Triggers, Cloud Scheduler) or an in-process timer on the standalone platform.

## Core pipeline (L2/L3)

1. **Ingest app** — `POST /api/:projectId/envelope/` and legacy `/store/`; DSN key auth
   (`X-Sentry-Auth` / `sentry_key` query), CORS, rate limit via KV, size limits,
   gzip/deflate/br decoding; write raw envelope to BlobStore; enqueue `{projectId, blobKey, receivedAt}`; return `{id}`.
2. **Consumer** — parse envelope items; drop unsupported item types; normalize event;
   symbolicate JS frames (debug-ID lookup → artifact bundle in BlobStore → `@jridgewell/trace-mapping`);
   compute grouping hash (client `fingerprint` → exception type + in-app frames → message fallback);
   in direct mode call atomic `store.recordEvent(occurrence, event)` (a redelivered event returns `inserted: false` and is dropped). Grouped mode hands normalized records to the issue-keyed stage below; notifications remain a future feature.
3. **API app** — Sentry-compatible subset under `/api/0/`: what sentry-cli needs (auth token
   check, chunk-upload, artifact bundle assemble, releases CRUD/finalize/deploys) plus
   issue/event list/get/update for a later UI.
4. **Cron** — archival, retention of raw envelopes, release-artifact GC.

### Release and sourcemap upload (M5a)

The API app serves what `sentry-cli releases new|finalize|list`, `deploys new` and
`sourcemaps upload` (debug-ID artifact bundles only) call, all behind the existing API-token
middleware (`event:read` for GET, `event:write` for POST/PUT; no new scope):

- `GET|POST /api/0/organizations/{org}/chunk-upload/`: the GET returns `url`, `chunkSize`,
  `chunksPerRequest`, `maxRequestSize`, `maxFileSize`, `concurrency`, `hashAlgorithm: sha1`,
  `compression: [gzip]`, `accept: [artifact_bundles]`. The POST takes multipart parts `file` or
  `file_gzip` whose filename is the SHA-1 of the (decompressed) chunk; every chunk is verified,
  gzip inflation is bounded by `chunkSize`, and the body by `maxRequestSize`. Defaults are 1 MiB
  chunks, 3 per request and a 32 MiB bundle: a Lambda function URL accepts about 4.5 MiB of raw
  request body, and one bundle is held in memory once while it is assembled.
- `POST /api/0/organizations/{org}/artifactbundle/assemble/`: `{checksum, chunks, projects,
  version?, dist?}` returns `{state, missingChunks, detail?}`. Assembly is synchronous inside the
  request (it reads at most `maxFileSize` bytes, inflates only `manifest.json`, and issues one
  store call per 100 debug IDs), so only `not_found` (with the missing chunks), `ok` and `error`
  are returned. It is idempotent and resumable: the bundle id is the checksum, a retry adopts the
  stored pending row (`getBundle`), and a finished assembly answers `ok` without its chunks.
  Concurrent first attempts may each pick a manifest key; `beginBundle` lets one win, the loser
  adopts the stored row and deletes its own manifest blob. A pending row past `pendingExpiresAt`
  (or claimed by cleanup) is cleaned up inline with the existing cleanup protocol and the
  assembly starts over. The release named by the request is created even when the bundle was
  already active. A bundle needs at least one debug ID (`sentry-cli sourcemaps
  inject`); re-uploading the same debug-ID set under another checksum is a no-op, while a partial
  overlap with an active bundle is an `error` (ownership is exclusive per project). `dist` is
  accepted and not stored.
- Releases (organization and project routes): create (201, or 208 when it exists), get, list, PUT
  with `dateReleased` to finalize (first finalize wins), deploys create/list. Releases are stored
  per project; organization routes fan out over the named projects (`ProjectRepo.listByOrg`;
  the DynamoDB adapter filters its shared project index one page per call) and list only after
  reading every release, refusing past 1000 instead of truncating. Commits, refs and archiving
  are refused with 400; legacy release-file, release-bundle assemble and DIF endpoints answer
  400 with a pointer to the debug-ID flow. Deploys are kept as one JSON blob per release
  (`TODO(M5)`: move to `ReleaseRepo` if concurrent deploys matter).
- Blob layout, all under `artifacts/` (already granted to every role that holds blob access):
  `chunks/<orgId>/<sha1>` (organization-scoped, deleted after assembly or a deterministic
  failure, S3 lifecycle rule `abandoned-artifact-chunks` after 7 days),
  `bundles/<projectId>/<checksum>`, `manifests/<projectId>/<checksum>/<pendingExpiresAt>`
  (the expiry moves on with every new attempt, so a key is not reused for a new bundle row),
  `deploys/<projectId>/<releaseId>.json`. Pending-bundle cleanup deletes the bundle and manifest
  blobs. The API role already held store read/write/metadata-delete and blob
  read/write/delete, so no grant changed.

Stack-level `rateRejection` describes optional per-issue and new-issue fixed-window limits and
an `onKvFailure` policy. Both limits are disabled by default; an explicit enabled limit is
active when configured. The consumer checks per-issue limits after suppression in both modes,
and checks the new-issue cap in direct mode; the grouped record handler checks the cap. Rejected
events are acknowledged without recording or forwarding. `onKvFailure` defaults to `allow`.
The consumer receives KV read and write access when its checks need it; the grouped record
role receives it for the new-issue cap. In grouped mode the consumer has no store grants except a
read-only `project-read` capability, derived only when `issueRateLimit` is enabled, so it can
resolve per-project overrides: on DynamoDB it is `GetItem` on the table alone, conditioned on
`dynamodb:LeadingKeys` matching `PROJECT|*` (project records only, no indexes, no writes); SQL
stores have one database role for every function, so there it equals the single connect grant and
the restriction is in code, where the platform hands the consumer only a `projects.get` reader. Issue list and detail responses include `approximateDropped` for the current fixed window when
limits are enabled; its bounds and `receivedAt` basis make delayed-event attribution explicit.
A KV read failure omits the field without failing the request.

Per-project overrides: `Project.rateLimits` (`issueEvents`, `newIssues`; counts only, the windows
stay stack-wide) can only tighten the stack. The effective limit is the lower of the stack's and the
project's value for a limit the stack enables; a project value for a disabled limit is rejected on
write and ignored on read, and an invalid or higher stored value is clamped to the stack's. The
operator sets them with `errtraq project rate-limits` and the `errtraq bootstrap` options. The
consumer and record handler read each project at most once per delivery batch, and not at all when
`rateRejection` is disabled. The grouped consumer reads projects through the `project-read` grant above, so the
per-issue override works in both modes; the new-issue cap override is enforced by the record
handler in both modes.

Cost and accuracy: charging is exact under retries and redelivery. The KV has no put-if-absent, so
an `increment` that returns 1 on a marker key (`rate:charged:<kind>:...`, per event for the issue
limit and dropped counter, per issue and window for the new-issue cap) is the atomic first-attempt
signal. Only a first attempt charges the counter; it then stores its decision under
`rate:outcome:<kind>:...`, and retries reuse it. If charging fails the marker is deleted so a retry
charges again. Cost per decision is therefore one marker increment, one counter increment per
(project, issue, window) group and one outcome write per event, plus a dropped marker per rejected
event and one dropped counter per group; the DynamoDB KV adapter also reads on each increment.
A crash between the counter and the outcome admits the retried event once uncharged, concurrent
attempts that find no outcome yet are admitted uncharged, and a crash can still lose a dropped
increment. A delayed event counts in its `receivedAt` window.

### Issue-keyed record stage (M3, partially implemented)

`recordMode` is a stack-level setting: `direct` retains the current consumer write path;
`grouped` adds a `record` topic, produced by the normalizing consumer and consumed by a new
`record` role. The separate role permits independent scaling, grants and timeouts; it can share
a physical function through the normal split configuration. Lambda stacks using SQS default to grouped; standalone stacks default to direct. Validation
rejects grouped mode unless the record queue declares grouped
delivery, the record role is deployed, the active store supports the operation, and all record
bindings, policies, triggers and limits are available. It never silently falls back to direct.

```ts
// Simplified sketch; packages/core/src/ports.ts defines the full contracts.
interface Message { key: string; body: unknown; groupKey?: string }
type QueueGrouping = "none" | "per-key-serial";
interface RecordInput { occurrence: Occurrence; event: StoredEvent }
interface RecordResult { inserted: boolean; issue: Issue; isNew: boolean; isRegression: boolean }
interface ActiveStore {
  capabilities: { /* existing fields */ recordEvents: boolean };
  recordEvent(occurrence: Occurrence, event: StoredEvent): Promise<RecordResult>;
  recordEvents(group: readonly RecordInput[]): Promise<readonly RecordResult[]>;
}
```

In grouped mode each message contains a versioned `RecordInput`, including `payloadBlobKey` when
present; `key` is the event ID and `groupKey` is the deterministic issue ID, already hashed from
project ID and fingerprint. The consumer writes overflow payloads before publishing. It checks
the entire serialized message against the adapter limit, including envelope overhead: the 200,000
byte raw-payload threshold alone does not bound normalized metadata or JSON expansion. If needed,
it writes the complete normalized record to a uniquely keyed durable blob and queues a bounded
claim check. Publish failures retry the original envelope; it is deleted and acknowledged only
after every record has been accepted. Earlier accepted records can be resent, so both publishing
and recording are idempotent. A producer cannot delete data merely because it sent the reference:
claim checks expire through a bucket lifecycle rule (default 30 days, validated above SQS's 14-day
maximum retention), and a message redriven after expiry fails as poison back into the DLQ.
Overflow payloads are deleted after their events by retention (event first, blob second), with a
lifecycle rule sweeping orphans after the longest project retention plus a margin.

`per-key-serial` means an adapter delivers accepted messages in queue acceptance order within a
key and does not intentionally dispatch a second live batch for that key until the first is
settled or its visibility lease expires. Different keys may proceed concurrently, and a batch
may contain several keys. This is **at-least-once**, not a lock: an expired visibility lease,
crash, redelivery, overlapping producers or manual redrive can cause concurrent work and retries.
A producer cannot infer an order across independent senders before the queue accepts their sends;
received timestamps, in particular, need not be in queue order. Database conditional writes,
per-event deduplication and transaction retries remain required. Tests cover lease expiry and
redelivery as well as serial batches while the lease is valid.

SQS uses a distinct FIFO physical queue and FIFO DLQ for `record` even in shared mode. Its
`MessageGroupId` is the issue ID and `MessageDeduplicationId` is the event ID, with per-message-
group deduplication scope; the five-minute filter is an optimization, never the idempotency
boundary. FIFO producer batching must handle partial send success without assuming failed entries
were enqueued before later accepted entries; the guaranteed order is the order SQS accepts.
Lambda uses a separate event source mapping, `ReportBatchItemFailures`, batch size at most 10 in
this design, and serial processing within a group. The memory queue implements the same contract;
queues without grouping may use direct mode, but grouped mode fails validation.

The record handler partitions a received batch by group, validates each ordered group, and invokes
`recordEvents` on a bounded same-issue group. Split an oversized multi-record group into ordered,
contiguous transactions before writing; a single record that cannot fit is a poison record. A successful group transaction atomically commits
all its new events and its one issue update; it returns one result per input in order, including
no-op duplicates. If a poison record can be identified before the transaction, process only the
valid prefix, then return that record **and all later unprocessed FIFO records** as failures.
A transaction failure fails the whole attempted group; no later same-group record is acknowledged.
The poison record retries and eventually moves to its FIFO DLQ after `maxReceiveCount`; only then
can later records progress. Its removal creates an intentional gap in recorded order; redrive may
place it after later records, and operators must inspect and redrive it. If a failure cannot be
attributed to one record, fail the entire affected group rather than guessing. Lambda's FIFO
guidance requires returning all failed and unprocessed records after the first failure in the
invocation; mixed groups must follow that conservative rule too. [AWS partial-batch guidance](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html).

`recordEvents` accepts 1..10 inputs for the initial portable contract, all with the same project,
issue and fingerprint, matching occurrence/event identity and receivedAt. Reject invalid inputs
and an oversized transaction before any mutation. The whole group of new records commits or none
does; duplicates within the batch and records already committed are no-ops. Per-input results
are in input order: only the first occurrence of a newly committed ID is inserted; `isNew` and
`isRegression` belong to the first newly inserted event causing those transitions in input order.
The returned issue is the committed post-group issue (or the actual stored issue for a duplicate
belonging to another issue); a subsequent concurrent update can make a post-commit read newer.
A duplicate-only group performs no issue mutation. Consumers may retry ambiguous commits and must
not emit duplicate side effects. A reliable notification outbox is future work, so notifications
must not be advertised as exactly-once. Every store declares the `recordEvents` capability and
provides the method; adapters that declare it unsupported reject the method and grouped-stack
validation rejects them. SQLite, Postgres, the memory fake and DynamoDB support the shared
contract; the detailed transaction design is in
[the DynamoDB design](.agents-docs/DYNAMODB_DESIGN.md).

This reduces contention in the ordinary lease-valid path, not as an absolute correctness guarantee.
Switching modes or remapping queues requires pausing producers, draining both old queues and in-flight
work, and resuming only one mode; mixed old and new consumers or an operator writing directly can
otherwise contend. See [the implementation plan](.agents-docs/ISSUE_KEYED_QUEUE_PLAN.md) for the
staged rollout, cost assumptions and unconfirmed AWS/emulator behavior.

## Archival job (moving events from the active store to Iceberg)

Constraints it is designed for: bounded invocation time (Lambda 15 min, Workers far less),
at-least-once triggers, no cross-system transaction between the active store and Iceberg,
and stores as different as Postgres and DynamoDB.

**Invariants**

1. An event is deleted from the active store only after the Iceberg snapshot containing it is committed.
2. Each batch is committed to Iceberg at most once (idempotent retry).
3. Only rows that were actually archived are deleted — never a range delete.
4. Time basis is server-side `receivedAt`, not the client `timestamp` (client clocks are arbitrary).

**Shape: planner → per-project worker, both on existing ports**

- A cron job fires the **planner** (hourly/daily). It pages through projects and sends one
  `archive.project {projectId}` message per project on the `Queue` port. Cross-project
  parallelism = queue consumer concurrency, which is also the throttle on active-store load.
- The **worker** handles one project per message, serially, under a lease. It loops over
  batches until nothing older than `cutoff = now − project.retention` remains or ~60% of the
  invocation time budget is used, then re-enqueues the same message as a continuation.

**Per-project state** (one record in `MetaRepo`, every transition a compare-and-set on `version`;
SQL `UPDATE … WHERE version = ?`, DynamoDB `ConditionExpression`):

```ts
interface ArchiveState {
  projectId: string; version: number;
  archivedThrough: Timestamp;                 // monotonic watermark (max receivedAt committed)
  seq: number;                                // batch counter -> batchId = `${projectId}/${seq}`
  batch?: { id: string; state: 'staged' | 'committed'; stagedKey: string;
            rowCount: number; dayRange: [Day, Day]; maxReceivedAt: Timestamp };
  lease?: { owner: string; until: Timestamp };  // expiry ≈ 2× invocation timeout; CAS doubles as fencing
}
```

**Batch state machine** (a batch = up to N rows / M bytes, e.g. 50k rows or 128 MB)

| Step | Action | If we crash right after |
|---|---|---|
| 1 SCAN | `events.scanOlderThan(project, cutoff, limit)` ordered by (receivedAt, eventId); because finished batches are deleted, the scan always starts at the oldest remaining row — no cursor to persist. Overflow payloads are re-inlined from BlobStore. | Nothing written; retry rescans. |
| 2 STAGE | Write the rows to `BlobStore` at `archive-staging/<batchId>-<nonce>.parquet` (the nonce stops a stale lease holder overwriting a newer owner's staged object), then CAS `batch = {state:'staged', …}`. The staged object is the write-ahead record: it is both the exact content to append and the exact id list to delete. | Orphan staged object without state → overwritten by the retry (same key). |
| 3 COMMIT | `archive.append({batchId, stagedKey, dayRange})` — one Iceberg snapshot, rows tagged `archive_batch = batchId`, split by day partition. Catalog 409s (concurrent commits from other projects) are retried inside the adapter. | State still `staged`: retry first calls `archive.hasBatch(batchId, dayRange)`; if true skip to step 4, else append again from the same staged object. This is what makes the commit exactly-once. |
| 4 MARK | CAS `batch.state = 'committed'`, `archivedThrough = max(old, maxReceivedAt)`. | Covered by the `hasBatch` probe above. |
| 5 DELETE | Read ids from the staged object; `events.deleteBatch` in store-sized chunks (DynamoDB 25, D1 ≤100 bound params, pg/mysql ~1000); delete overflow blobs. Idempotent. | State `committed`: retry redoes the deletes. Readers see duplicates meanwhile, removed by eventId dedupe. |
| 6 CLEAR | CAS `batch = undefined`, `seq += 1`; delete the staged object. Next batch. | Staged object leaks → bucket lifecycle rule on `archive-staging/` (7 days). |

On entry the worker resumes from whatever `batch.state` it finds, so a timed-out invocation,
a redelivered message, or a lease takeover all converge on the same path.

**Why this stays correct**

- *Late events* (queue retries, DLQ redrive) land in the active store with an old `receivedAt`;
  the next run's scan picks them up naturally since it is "everything older than cutoff", not
  "between watermark and cutoff". Readers never miss them because the active store is always queried.
- *Rows inserted into an already-scanned range between scan and delete* survive, because step 5
  deletes by id list, not by range.
- *Two workers on one project*: lease prevents it; if a lease expires mid-flight, the stale
  worker's next CAS fails and it stops. A stale append is still caught by `hasBatch`.
- *Issues are untouched*: counters and first/last-seen live on the issue row. The issue keeps
  `lastEventId + lastEventReceivedAt` so "latest event" can be fetched from the archive with a
  day hint instead of a table scan.

**How the commit is done per engine** (the only engine-specific step)

- DuckDB (local, Lambda, Cloud Run): `INSERT INTO cat.events SELECT *, '<batchId>' FROM read_parquet('<staged>')` against the REST catalog (Lakekeeper / S3 Tables).
- Native committer (fallback, and the likely answer for Workers): the staged Parquet is written
  straight into the table's data location, so COMMIT is just manifest + REST `commit` adding that
  file — and `hasBatch` can read the snapshot summary property instead of querying.
- Cloudflare Pipelines / Athena variants are evaluated in the M4/M6 spikes; the state machine does not change.

**Store-specific delete strategies** (declared as an `EventRepo` capability)

- `explicit` (default, all stores): step 5 as above.
- `ttl` (opt-in, DynamoDB / Firestore): events get a TTL of `retention + grace` at insert and
  the store expires them for free; step 5 becomes a no-op and the worker keeps a scan cursor in
  `ArchiveState` instead. Cheaper at volume, but archival falling behind by more than `grace`
  loses data — so the planner alarms on lag.
- Later optimization for Postgres/MySQL: day-partitioned event table and `DROP PARTITION`.

**Archive-side housekeeping** (separate cron job, catalog-dependent)

- Hard retention: `DELETE WHERE received_at < now − archiveRetention` → whole-partition, metadata-only.
- Project deletion: `DELETE WHERE project_id = ?` drops whole files (single-project files).
- End-user erasure requests: row-level, via deletion vectors — see next section.
- Small-file compaction (must keep one project per file or sort by `project_id`), snapshot
  expiry and orphan-file cleanup: automatic on S3 Tables and R2 Data Catalog; run via the engine for Lakekeeper.

**Observability**: per run emit rows archived, batches, and *archival lag* = `cutoff − oldest
active receivedAt` per project; lag is the single health signal to alert on.

## End-user PII erasure (deletion vectors)

Requirement: an end user of a monitored app asks for their data to be erased; every event
carrying their identity must disappear from both tiers, without rewriting the archive on the
request path.

**Table format**: the `events` table is created as **Iceberg format v3** with
`write.delete.mode = merge-on-read`, so row deletes are **deletion vectors** (one Puffin
`deletion-vector-v1` blob per affected data file) instead of file rewrites.

**Finding the subject's rows**: subject erasure is unavailable until M4. The planned independent
`SubjectIndex` is written inline by the consumer, with Parquet files in blob storage. Archive
queries use reduced subject-key columns. See `.agents-docs/SUBJECT_INDEX_DESIGN.md`; proving
completion in the presence of a committed but unindexed event still in the main queue is an M4
blocker. Dropping a promoted field does not scrub a raw value from the nested payload.

**Port additions**

```ts
interface ArchiveStore {
  // ...
  deleteWhere(req: { erasureId: string; projectId: string; selector: SubjectSelector }):
    Promise<{ snapshotId: string | null; rowsDeleted: number; files: string[] }>;      // logical: commits DVs
  hardErase(req: { erasureId: string; files: string[] }): Promise<{ snapshotId: string }>; // physical: rewrite files applying DVs
  expireSnapshots(olderThan: Timestamp): Promise<void>;                                  // + orphan file removal
  capabilities: { rowDelete: 'deletion-vector' | 'position-delete' | 'copy-on-write' };
}
// M4 adds a separate SubjectIndex and count-preserving issue pointer repair.
```

DynamoDB point-in-time recovery can retain erased active-store data for up to 35 days; the M3
erasure design must explicitly account for backup retention and operational deletion.

**Deletion vectors mask, they do not erase.** After the DV commit the rows are invisible to
every reader, but the bytes remain in the Parquet file and in older snapshots. So an erasure
request is a two-phase ledger entry (`ErasureRequest` in `MetaRepo`, CAS transitions, exposed
at `POST/GET /api/0/projects/{org}/{project}/erasure-requests/` — an errtraq extension, Sentry
has no equivalent). The state table below describes the planned M4 workflow; it is not a
currently available endpoint. Main-queue drain proof remains a blocker to claiming completion.

| State | Work | Timing |
|---|---|---|
| `received` | Persist request; publish selector to `KV` suppression list so the consumer drops still-queued events from that subject with `receivedAt ≤ requestedAt`. | Synchronous |
| `active-purged` | Under the project's **archive lease** (serializes with the archival worker): first drive any in-flight archive batch to completion so nothing is sitting in staging, then use the planned SubjectIndex to identify active event IDs, delete them and their overflow blobs, and repair latest-event pointers without decrementing counts. Completion remains blocked on proving main-queue drain. | Minutes |
| `archive-masked` | `archive.deleteWhere` → one snapshot adding DVs; record `maskSnapshotId` and a blob key holding the touched file list (the list can exceed a key-value store's item size). From here no query returns the data. | Minutes |
| `archive-erased` | `archive.hardErase(files)` rewrites just the touched data files without the deleted rows (cheap: files are one project-batch each), then `expireSnapshots` once the pre-rewrite snapshots age past the table's max snapshot age (set to 7 days) and orphan files are removed. | Cron, well inside the 30-day GDPR window |
| `done` | Stamp completion time; replace the stored selector with a salted hash so the ledger is an audit trail that holds no PII. | — |

Taking the archive lease in `active-purged` is what closes the race where a staged batch
containing the subject's rows would otherwise be committed *after* the archive was masked.
Every step is idempotent (re-deleting matches nothing; DV snapshot carries
`errtraq.erasure-id` in its summary), so the same resume-from-state worker pattern as archival applies.

**Engine support** (extends the M4 spike; this is the least-certain part of the plan)

- **Open problem: `hardErase` on v3.** DuckDB 2.0 refuses `iceberg_rewrite_data_files` on
  format-v3 tables ("does not yet support V3 tables"; it works on v2), and after a
  deletion-vector-only delete the rows are still readable in the data files. S3 Tables
  maintenance was not observed to remove them within the spike, and its retention minimums
  (1 hour for snapshots, 1 day for unreferenced files) put a floor under any erasure deadline.
  Candidates, to be decided in M4: rely on catalog maintenance once it is shown to apply
  deletion vectors; copy-forward the affected partitions into new files and drop the old ones;
  keep the archive at format v2 (position deletes, DuckDB rewrite works); or a native rewrite.

- Verify which engines can *write* v3 DVs through a REST catalog and *honor* them on read:
  DuckDB's iceberg extension, Athena / S3 Tables, R2 Data Catalog. Lakekeeper is catalog-only
  and format-agnostic, so it is not the constraint.
- If the chosen engine cannot write DVs, the native committer does it: query matching
  `(file_path, row_position)` pairs via the engine, build a roaring bitmap per file — merging
  with the file's existing DV, since v3 allows at most one per data file — write the Puffin
  file, and commit a delete manifest through the REST catalog.
- `capabilities.rowDelete` lets a stack degrade to v2 position deletes or copy-on-write where
  v3 is unavailable; the ledger and API are identical, only `archive-masked` gets slower.
- Compaction must apply DVs (it then counts as hard erase for those files).

## Stack configuration + infra abstraction

A stack selects a platform and adapters once for runtime wiring and infrastructure
provisioning. Adapter descriptors declare resources, capability policies, purpose-scoped
bindings and typed module outputs, including keyed maps. Core owns the role requirements and
topic routes; validation derives per-function grants and bindings from them. Platform manifests
state their authorization style, binding kinds and runtime environment guarantees. Platform
config defines role grouping, HTTP exposure and settings; the derived deployment view supplies
functions, bindings, policies, triggers and build artifact references to descriptor inputs. Child
selections inherit parent-port access, and deployed functions construct only their required
adapters using delivered binding names. Platform manifests declare supported config references.

Symbol-tagged references distinguish module outputs, provider values, Terraform variables,
runtime or generation-time environment values, and build artifacts. Existing resources supply
only reachable outputs. Validation checks supported capabilities, reference types, queue timing,
provider metadata, binding scopes and separate module / runtime dependency graphs. Resolved
stack data is frozen and factories are constructed in dependency order, then closed in reverse
order. The local platform runs in one process. See [INFRA_MODEL.md](./.agents-docs/INFRA_MODEL.md)
for the exact types, resolution phases and validated shared and per-topic examples. The pure
Terraform generator composes hand-written AWS modules and the CLI validates stacks, emits
role-scoped Lambda ZIPs and generates roots using their verified artifact manifests. Lambda
function URLs supply ingest CORS; the app does not duplicate those headers on Lambda. Optional
`awsLambda({ artifactBucket: "existing-bucket" })` uploads content-addressed ZIPs through
Terraform to an operator-owned, same-region S3 bucket before deployment. The operator must grant
the Terraform principal access to manage those objects; the module does not create the bucket.
Without the setting, ZIPs use direct upload and the CLI rejects ZIPs above a conservative 50 MB. Output files
use relative paths and marked directories. The standalone build includes a non-root Node 22
container with a persistent data volume; its explicit container host setting exposes the server
to the container network while ordinary local runs default to loopback. Postgres can use a bring-your-own RDS IAM identity, with an exact database-user connect policy;
one database user is shared by the store capabilities, and SQL privileges, rather than IAM,
control read, write and delete. Lambda can use operator-provided subnet and security-group IDs;
private functions need NAT or suitable service endpoints for their AWS API calls. AWS runtime
adapters and deployed secret sources are implemented; the first real AWS deployment passed.
Further AWS verification and remaining M3 work are tracked in the agent documents.

### Deployed bootstrap

Bootstrap (migrations, the first organization, project, DSN key and API token, and the bootstrap
secret holding the DSN and token) has two paths that share one idempotent implementation in core
(`bootstrapDeployed`). The direct path runs `errtraq bootstrap` from the operator's machine with
the operator's AWS credentials (environment keys first, otherwise the SDK profile chain: `AWS_PROFILE`, SSO, `credential_process`, assume-role; resolved in the CLI only, never in Lambda bundles); it needs network access to the store. When the store is reachable
only inside the VPC, the AWS Lambda platform offers an optional sixth function role, `bootstrap`
(`awsLambda({ roles: [..., "bootstrap"], bootstrapSecretName })`), and `errtraq bootstrap --remote`
invokes it synchronously through the Lambda Invoke API (signed with `aws-signing`, no SDK).

The role is operator-invoked only: no function URL, queue trigger or schedule. It is never grouped
into `shared` (core always gives it its own physical function), shares the platform's VPC
placement, and its requirement rows are store and KV `read` and `write`, which is exactly what the
bootstrap repository calls need (project IDs come from the KV counter). For DynamoDB these are
the ordinary table policies; for Postgres IAM the same connect grant every runtime role has. Its
only other IAM statement, created by the `lambda-app` module, allows `secretsmanager:CreateSecret`,
`DescribeSecret` and `GetSecretValue` on `arn:...:secret:<bootstrapSecretName>-??????`, the one
secret name fixed in the platform config and delivered as `ERRTRAQ_BOOTSTRAP_SECRET_NAME`. The
function creates the secret with its value (create-or-read, so concurrent and repeated runs
converge), so `PutSecretValue` is not needed and nothing secret passes through Terraform.

The request accepts only non-secret fields (`orgSlug`, `projectSlug`, `ingestUrl`, optional
tighter `rateLimits`; unknown fields are refused) and is validated with the local path's rules,
with retention and rate limits checked against the stack baked into the artifact. The response is
a summary of ids, slugs and created-or-existing flags; failures return a scrubbed error document
(fixed text, or the stack's own messages) and log only the error class and a short code. The
operator needs `lambda:InvokeFunction` on that one function and, to read the DSN and token,
`secretsmanager:GetSecretValue` on the secret.

For Postgres IAM, the `postgres({ mode: "iam", ..., adminSecret })` selection accepts a stack
variable holding the ARN of a Secrets Manager secret with administrator credentials (`username`
and `password`, the RDS-managed master secret format). Core models this as a store capability
`admin` with no policy output, delivered as a secret binding to the bootstrap role alone; runtime
roles never receive the binding or the read grant. With it, the store's `migrate()` first connects
as the administrator over verified TLS, idempotently creates the IAM user (`CREATE ROLE ... LOGIN`,
`GRANT rds_iam`, connect, schema and existing-table privileges, identifiers quoted), then migrates
as the IAM user. Migrating as the IAM user makes it the owner of the tables, so later migrations
need no further grants and the administrator credentials are used only for role administration.

## Milestones

| | Scope | Proves |
|---|---|---|
| **M0** | Workspace scaffold, `core` ports + domain types, stack-config schema, `testing` contract suites, memory fakes | The abstractions |
| **M1** | Local standalone: `store-sql` (sqlite), `queue-memory`, `blob-fs`, ingest → consumer → issues, minimal API | End-to-end with real Sentry SDKs |
| **M2** | Completed: infra model, AWS HCL modules and generator; `validate/build/infra generate`, Lambda handler scaffolding and standalone container | The infra abstraction |
| **M3** | AWS runtime adapters, postgres dialect, deployed secrets and real deployment | First cloud target |
| **M4** | Archive: REST catalog client, DuckDB engine, archival job, federated query, erasure requests with v3 deletion vectors; Lakekeeper+winterbaume in compose; engine spike | Hot/cold tiering |
| **M5** | Releases, chunk upload, artifact bundles, JS symbolication. M5a (done): the sentry-cli upload path. M5b: symbolication, cleanup cron wiring, Cloudflare | sentry-cli compatibility |
| **M6** | Cloudflare: Workers platform, d1 dialect, `queue-cf`, R2, R2 Data Catalog | Most constrained runtime |
| **M7+** | Remaining adapters (mysql, turso, supabase, firestore, redis, nats, pubsub, cloud tasks, service bus, gcs, azure), Cloud Run/Vercel platforms, web UI, alerts | Breadth |

First implementation round = **M0–M2** (plus `git init`).

## Verification

- **Contract tests** (`packages/testing`): one vitest suite per port (`activeStoreContract`,
  `queueContract`, `blobStoreContract`, `archiveStoreContract`) run against every adapter;
  cloud adapters run against `docker/compose` emulators (DynamoDB Local, ElasticMQ, winterbaume,
  Lakekeeper) and Miniflare for Cloudflare. An adapter is "done" when its contract suite passes.
- **winterbaume as the local S3** (replaces MinIO; `winterbaume-server`, docs at
  winterbaume.pages.dev): it only supports **path-style** addressing on a custom endpoint, so
  `blob-s3` takes a `forcePathStyle` option, and Lakekeeper's warehouse, DuckDB
  (`s3_url_style='path'`) and the Terraform AWS provider (`s3_use_path_style`) are configured
  the same way. During M3, check whether its DynamoDB / SQS coverage is good enough to also
  replace DynamoDB Local and ElasticMQ, leaving one AWS emulator in compose.
- **E2E (M1)**: `errtraq dev --stack local`, then a script using real `@sentry/node` and
  `sentry-sdk` (Python) with the local DSN: send exceptions, assert via API that issues group
  correctly, counts bump, and duplicate eventIds are idempotent.
- **Infra-gen (M2)**: snapshot tests of generated `main.tf.json` per example stack;
  `terraform validate` on each generated root in CI; `errtraq validate` negative tests
  (e.g. NATS pull queue + Lambda-only compute is rejected).
- **AWS (M3)**: `terraform apply` of `stacks/aws-dynamodb.ts` into a sandbox account, run the same E2E script against the function URL, `terraform destroy`.
- **Archival crash-safety (M4)**: a fault-injection test kills the worker after each of the six
  steps in turn, reruns it, and asserts no event is lost, none is duplicated in Iceberg, and
  the active store ends up empty below the cutoff; plus a late-event test (insert below the
  watermark, query before and after the next run).
- **Erasure (M4)**: seed events for two users across both tiers, submit an erasure request for
  one; assert (a) federated queries return nothing for that user right after `archive-masked`,
  (b) the snapshot contains Puffin DVs and no rewritten data files, (c) after `hardErase` +
  snapshot expiry, a raw byte scan of every object under the table location finds no occurrence
  of the user's email, (d) the other user's events are intact, (e) an erasure racing a staged
  archive batch still ends clean.
- **Archive (M4)**: seed events, run archival with a short cutoff, assert rows in Iceberg (query via DuckDB against Lakekeeper), assert a cross-watermark `listByIssue` returns a gapless, duplicate-free, correctly ordered page sequence.
- **Sourcemaps (M5)**: `sentry-cli sourcemaps inject/upload` against the local server, send a minified-stack error, assert symbolicated frames.
