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
  projects: ProjectRepo;      // orgs, projects, DSN keys, API tokens; lookups by id and by slug
  issues: IssueRepo;
  events: EventRepo;
  releases: ReleaseRepo;      // releases (by id and version), artifact bundles, debug-id index
  meta: MetaRepo;             // ArchiveState and ErasureRequest records, compare-and-set on version
  capabilities: { textSearch: boolean; lastSeenRangeOnOtherSort: boolean };
  migrate(): Promise<void>;
}
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
  interrupted cleanup remains resumable. SQL schema version 4 marks legacy bundles active.
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
- DynamoDB: single-table design (PK `P#<project>`, SKs for issue/event, GSIs for
  lastSeen/fingerprint). Firestore: per-project subcollections + composite indexes.
- Event payloads above a size threshold (DynamoDB 400 KB, D1 row limits) overflow to BlobStore
  by reference — handled in core, not per adapter.

### Queue — unify push and pull delivery
```ts
interface Message  { key: string; body: unknown }                    // key = idempotency key (the eventId for event messages)
interface Delivery { id: string; topic: Topic; message: Message; attempt: number }
interface QueueProducer { send(topic: Topic, msgs: Message[], opts?: { delaySec?: number }): Promise<void>; }
type BatchHandler = (batch: Delivery[]) => Promise<BatchResult>;   // per-delivery ack | retry(delaySec)
interface PushSource<E, R> { handle(platformEvent: E, handler: BatchHandler): Promise<R>; }   // SQS event, CF MessageBatch, Pub/Sub push, Cloud Tasks HTTP
interface PullSource { run(handler: BatchHandler, signal: AbortSignal): Promise<void>; }      // memory, Redis streams, NATS JetStream, Service Bus
interface Queue { producer: QueueProducer; pull?: PullSource; push?: PushSource; capabilities: { delivery: 'push' | 'pull' | 'both'; maxBytes: number; delay: boolean; dlq: boolean } }
```
- A push source owns the whole platform round trip (`handle`), because acknowledging is
  platform-specific and asynchronous: SQS retry delay is a `ChangeMessageVisibility` call,
  Cloudflare Queues ack / retry are methods on the original batch.
- Semantics contract: at-least-once, unordered; handlers are idempotent on the message key.
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
   one atomic `store.recordEvent(occurrence, event)` (a redelivered event returns `inserted: false` and is dropped); emit `issue.created` / `issue.regressed` to a notifications topic.
3. **API app** — Sentry-compatible subset under `/api/0/`: what sentry-cli needs (auth token
   check, chunk-upload, artifact bundle assemble, releases CRUD/finalize/deploys) plus
   issue/event list/get/update for a later UI.
4. **Cron** — archival, retention of raw envelopes, release-artifact GC.

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
role-scoped Lambda ZIPs and generates roots using their verified artifact manifests. Output files
use relative paths and marked directories. The standalone build includes a non-root Node 22
container with a persistent data volume; its explicit container host setting exposes the server
to the container network while ordinary local runs default to loopback. Postgres can use a bring-your-own RDS IAM identity, with an exact database-user connect policy;
one database user is shared by the store capabilities, and SQL privileges, rather than IAM,
control read, write and delete. Lambda can use operator-provided subnet and security-group IDs;
private functions need NAT or suitable service endpoints for their AWS API calls. Runtime AWS
adapters, deployed secret sources and a real cloud deployment remain M3 work.

## Milestones

| | Scope | Proves |
|---|---|---|
| **M0** | Workspace scaffold, `core` ports + domain types, stack-config schema, `testing` contract suites, memory fakes | The abstractions |
| **M1** | Local standalone: `store-sql` (sqlite), `queue-memory`, `blob-fs`, ingest → consumer → issues, minimal API | End-to-end with real Sentry SDKs |
| **M2** | Completed: infra model, AWS HCL modules and generator; `validate/build/infra generate`, Lambda handler scaffolding and standalone container | The infra abstraction |
| **M3** | AWS runtime adapters, postgres dialect, deployed secrets and real deployment | First cloud target |
| **M4** | Archive: REST catalog client, DuckDB engine, archival job, federated query, erasure requests with v3 deletion vectors; Lakekeeper+winterbaume in compose; engine spike | Hot/cold tiering |
| **M5** | Releases, chunk upload, artifact bundles, JS symbolication | sentry-cli compatibility |
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
