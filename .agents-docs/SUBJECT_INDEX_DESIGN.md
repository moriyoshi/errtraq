# Subject index, erasure and rate policy (M3e step 1c)

Status: proposed stage 4 design, except the stage 1 and 3 contract changes listed below. The owner chose an independent `SubjectIndex`
port written **inline by the consumer**, with a default Parquet-on-BlobStore implementation. It is not a DynamoDB index. The DynamoDB
design and staged order are in [DYNAMODB_DESIGN.md](./DYNAMODB_DESIGN.md). No background builder, admission ledger, epochs,
completeness certificate, `SubjectIndexCoordinator`, `ErasureWork` port, rejection ledger or sample policy is part of this design.
ARCHITECTURE.md / current ports must be updated at the corresponding implementation stages, not assumed changed now.

## Concrete correctness blocker to resolve before stage 4 completes

The owner's prescribed protocol is useful but its completion test is insufficient on the current SQS/Queue interfaces. Example: an
event commits before the fence, the consumer crashes before appending its index file, and that message remains delayed or is repeatedly
retried in the **main queue**. After `visibilityTimeout + functionTimeout`, the subject index and the DLQ can both be empty for two
passes while the committed event still exists. It may later be redelivered, when suppression purges it, but marking the erasure
complete beforehand is false. A stalled/disabled consumer, long backlog, multiple retries or replay extends that interval. An empty DLQ
is necessary under the requested rule, not proof the main queue has no such work. SQS queue metrics are approximate, invisible/delayed
messages exist, and the DLQ oldest-age metric measures time since redrive rather than original event `receivedAt`; see [SQS queue
metrics](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html) and [DLQ
retention](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/setting-up-dead-letter-queue-retention.html).
`Queue` currently exposes neither a durable complete old-work inventory nor a provable drain.

**Proposed safe behavior:** execute the requested wait, two empty passes and DLQ gate, keep suppression durable, and leave the request
in `active-purging` / pending until an operator or a future queue capability can establish that all pre-request work, including
invisible, delayed, main-queue and DLQ messages, is resolved. Approximate zero metrics / two empty polls can be an operational signal
but are not a proof. Alternatively the owner can explicitly accept a weaker, eventually reconciled completion guarantee and its privacy
consequence. Do not add the discarded work-ledger/epoch/coordinator design under another name. This blocker applies to claiming stage 4
erasure completion, **not** to beginning the stage 1 DynamoDB store.

## Port and consumer ordering

```ts
type SubjectField = "userId" | "email" | "username" | "ipAddress";
type ReducedSubjectKey = { field: SubjectField; version: string; digest: string };
type SubjectEntry = {
  projectId: ProjectId; subject: ReducedSubjectKey; issueId: IssueId;
  eventId: EventId; receivedAt: Timestamp;
  ordinal?: bigint; // optional future adapter optimization, never required for correctness
};
type SubjectEventRef = { projectId: ProjectId; issueId: IssueId; eventId: EventId; receivedAt: Timestamp };
type ProjectLeaseToken = { projectId: ProjectId; owner: string; version: number; until: Timestamp };
interface SubjectIndex {
  /** Idempotent by logical entry even when queue batches are regrouped on retry. */
  append(entries: readonly SubjectEntry[], deliveryIds: readonly string[]): Promise<void>;
  /** Exact matching keys and receivedAt <= before; page until nextCursor is null. */
  lookup(projectId: ProjectId, keys: readonly ReducedSubjectKey[], before: Timestamp,
         options: { lease: ProjectLeaseToken; cursor?: Cursor; limit?: number }): Promise<Page<SubjectEventRef>>;
  /** Idempotent logical removal for these event IDs across all fields and files. */
  remove(projectId: ProjectId, refs: readonly SubjectEventRef[]): Promise<void>;
  /** Publish compacted output safely; appenders may still write to the day. */
  compact(projectId: ProjectId, day: Day, lease: ProjectLeaseToken): Promise<void>;
  /** Delete only closed days strictly older than the project's safe retention cutoff. */
  expire(projectId: ProjectId, beforeDay: Day, lease: ProjectLeaseToken): Promise<void>;
}
type SubjectManifestRef = { projectId: ProjectId; day: Day; version: number; blobKey: string };
interface MetaRepo {
  getSubjectManifest(projectId: ProjectId, day: Day): Promise<SubjectManifestRef | null>;
  compareAndSetSubjectManifest(projectId: ProjectId, day: Day,
    expectedVersion: number | null, next: SubjectManifestRef, lease: ProjectLeaseToken): Promise<void>;
}
```

This interface belongs in core and is independent of `ActiveStore`. `SubjectEntry`'s HMAC key is not a reversible subject; event IDs
remain the canonical 128-bit identities. The optional ordinal is an optimization only and must not truncate or hash away identity. A
page cursor is scoped to project, keys, reducer versions, cutoff and snapshot/lease; reject malformed or cross-scope cursors.
Lease-taking operations validate the project and current fencing version and fail if the lease is lost. `lookup` dedupes event
references across fields, files and versions, validates `<= before`, and never treats a missing/corrupt file as an empty match.

For each consumer delivery batch: parse, normalize, check durable suppression **before** rate limiting, then execute `recordEvent` or a
bounded `recordEvents` issue group. Build entries from the committed stored event's normalized fields for every successful insertion
**and for an already-committed duplicate**; a crash after commit but before append must be repaired by redelivery. Existing
`events.get` early-continue in `consumer.ts` must therefore change in stage 4: on duplicate read the actual persisted event and append
its entries, not the new possibly different payload. Group entries by project and receivedAt day, append each group, then ack that
delivery only after its required writes succeeded. If one delivery has several projects/days or several envelope items, all its appends
must succeed before its ack; partial batch failures retry only affected deliveries. Suppressed deliveries whose events already exist
purge those event IDs, remove index entries, and remove associated blobs before ack. Never log raw PII, digests, peppers, receipt
handles or payloads. This ordering does not by itself solve the completion blocker above.

## PII reducer and archive representation

`SubjectReducer` is a core WebCrypto transformation, shared by all adapters and archive. The project config specifies per field `index:
"hmac" | "none"`, `storage: "raw" | "reduced" | "drop"`, normalization version and secret-store pepper ID. No IP-prefix HMAC in this
slice. Use HMAC-SHA-256, domain-separated and length-framed by project, field and version; a digest is not encryption, and index
entries remain personal data to erase. Defaults proposed: index all four using HMAC if a pepper is configured; store user ID, email and
username reduced and IP promoted field dropped. If no pepper / worker is configured, do not pretend indexed erasure is available:
validate configuration and return unsupported for `none` selectors.

- Trim, normalize Unicode consistently and record the exact normalization version. Email:
IDNA and lowercase the domain; preserve local-part case by default because case folding is not universally
correct. Opt-in local-part folding risks over-erasure. User ID/username keep case by default. Parse IPv4 and
IPv6 to canonical bytes; define IPv4-mapped IPv6 behavior explicitly. Reject invalid values, distinguish
absent and empty and use identical reducer logic for ingestion, selector and archive.
- The pepper prevents practical offline guessing **only while secret**. IPv4 addresses and
numeric user IDs are readily enumerable if it leaks; low-entropy email/username values can be guessed too.
Never put raw fields or pepper bytes in object names, stack variables, logs, metadata, metrics labels or
Terraform state.
- `raw` permits UI display and requires erasing the raw promoted value. `reduced` stores the
digest, permits equality but not plaintext display; `drop` removes only the promoted field. **Neither `drop`
nor `reduced` scrubs nested event JSON, overflow payload blobs, raw staged envelopes or arbitrary attachment
data.** Raw values can remain there until a separate payload scrubber / deletion / archive rewrite; defaults
are not a payload privacy guarantee. The archive stores the configured representation with reducer version and
must support `archive.deleteWhere` using reduced keys for reduced fields, not compare plaintext to hashes.
Backups/PITR, snapshots and raw envelope retention require their own deletion policies.
- Rotation adds a version: write the new pepper/version, keep all old versions queryable and
suppressible, and dual-write/backfill where originals exist. If data was only reduced or dropped, HMAC cannot
be reversed to derive a new digest: keep the old key until all related index, archive, queue and backup data
expire, or declare historic selector erasure unsupported if it is destroyed. Never hash an old digest as a
substitute for the original value.

Suggested stage 4 port surface:

```ts
interface SubjectReducer {
  reduce(projectId: ProjectId, field: SubjectField, value: string): Promise<readonly ReducedSubjectKey[]>;
  supports(projectId: ProjectId, field: SubjectField): Promise<boolean>;
}
type ArchiveErasureSelector =
  | { kind: "reduced"; keys: readonly ReducedSubjectKey[] }
  | { kind: "eventIds"; eventIds: readonly EventId[] };
// ArchiveStore.deleteWhere changes its selector to ArchiveErasureSelector for reduced storage.
```

`reduce` returns all active read versions for erasure, with a distinct write-version selection for ingestion; refine its signature
before implementation so the two cannot be confused. Test pepper isolation/rotation, same input across projects/fields,
email/IP/Unicode vectors, `none`, raw/reduced/drop payload behavior and secret non-disclosure. `SecretSource` provides the pepper; AWS
deployed secret resolution is M3g, and no pepper goes in the index filename.

## Default Parquet files and idempotency

A pure-JS writer usable in Workers is required; [hyparquet-writer](https://github.com/hyparam/hyparquet-writer) is a candidate and
documents split-block per-column bloom filters and row-group statistics. Its matching [reader](https://github.com/hyparam/hyparquet)
supports range-based Parquet reads; the cited README does not establish bloom-filter pruning. Stage 4 must pin a reviewed version,
verify Workers bundling, streaming/memory bounds, actual bloom filter read/pruning and Parquet interoperability, or implement/test the
missing bloom reader. No dependency is selected now. Never claim the range savings until those tests pass; fall back to reading all row
groups, not false negatives. Bloom filters are probabilistic accelerators, never correctness filters when missing/invalid.

Use distinct literal purpose prefix `subject-index/`, and percent-safe/encoded project and day components with no raw subject or email:

```text
subject-index/v1/p/<encoded-project>/d/<YYYY-MM-DD>/append/<batchHash>-<contentHash>.parquet
subject-index/v1/p/<encoded-project>/d/<YYYY-MM-DD>/compact/<contentHash>.parquet
subject-index/v1/p/<encoded-project>/d/<YYYY-MM-DD>/tombstone/<removalHash>.parquet
```

Sort/dedupe entries in canonical byte order; `batchHash = SHA256` of length-framed sorted stable logical delivery IDs (including source
namespace); `contentHash` hashes the canonical logical entries and reducer versions. Split mixed projects/days into separate files.
Repeating the same batch and content overwrites the same logical file with equivalent complete Parquet bytes; different content cannot
overwrite it. Regrouped retries can create more files, so lookup and compaction dedupe by `(project, field, reducerVersion, digest,
eventId)` and never infer idempotency merely from the batch ID. Ensure Parquet bytes are deterministic or at least semantically
identical on replay. A delivery ID or an event body alone is not a safe key when batch membership/partial failures change. Avoid
partial publication: `BlobStore.put` must atomically publish a whole object, with no acknowledged partial result. Do not append to an
existing Parquet object or rely on rename/CAS absent from `BlobStore`.

**Port precondition:** AWS S3 and R2 document strong read-after-write and listing for completed writes
([S3](https://docs.aws.amazon.com/AmazonS3/latest/userguide/), [R2](https://developers.cloudflare.com/r2/reference/consistency/)). The
present `BlobStore` contract does not yet promise either, a cross-page snapshot, or atomic whole-object publication. Stage 4 must add
explicit capability/contract tests for each selected adapter, including blob-fs concurrent put/list, or reject it for this
implementation. Strong per-request LIST is not a cross-page snapshot: a concurrent compaction can delete an unread source and publish a
replacement lexically behind a paging cursor. The archive lease below serializes erasure lookups with compaction; other callers must
also obtain the same lease or restart against a stable generation. Strong object storage cannot reveal an append not yet acknowledged
or one never attempted.

## Compaction, tombstones and retention

The cron compactor selects a **closed UTC day**, holds the project's existing archive lease, reads the current manifest and captures a
specific list of completed append files for that day. Sort/dedupe by `(field,version,digest,receivedAt,eventId)`, apply all durable
removal tombstones, and write an immutable new compact file, with a tested bloom filter on the reduced key and row-group min/max
statistics. For bounded memory / large days, stream/spill in bounded runs where the platform permits; a Workers-only writer must prove
the memory/time bound, or split the day into deterministic compact segments rather than claim one arbitrarily large file fits. Readers
prune by metadata and bloom, then range-read matching row groups and filter exactly.

Use a **per-project/day manifest**, not an admission/work ledger: store an immutable manifest body in BlobStore and atomically CAS its
reference/version via a narrowly added `MetaRepo` operation. It names the current compact file(s) and captured input object
keys/hashes. Write and verify compact output and manifest first, then CAS-publish the new manifest; only afterward delete the exact
captured append files and superseded compact inputs. A crash before publish leaves harmless orphan output; a crash after publish leaves
duplicates until cleanup. A source that vanished while reading causes abort/re-list, never a partial publish. A concurrent append not
in the captured key list remains visible under `append/` even for that old day; a later compaction incorporates it. Content-derived
immutable names prevent a stale cleanup deleting a new file with different content under the same name. Manifest publication atomically
checks the current lease fencing token as well as its expected version; manifest CAS alone cannot fence a stale holder after lease
takeover. Test cleanup interleavings and do not delete an input unless a durable published output contains it; stop cleanup on lease
loss and ensure a new holder cannot reference obsolete inputs. A lookup is serialized with compaction using the same archive lease,
because a manifest read and paginated LIST are not an atomic snapshot. Keep the lease for the full paginated operation or restart
safely after lease loss. One compaction per day is the normal result; late arrivals produce additional append files/temporary segments
until the next compaction, not guaranteed one file forever.

`remove` writes an immutable **tombstone** for `(project,eventId)` for each bounded removal batch, before reporting success; lookup
filters tombstoned IDs from every append/compact file, including later duplicate appends. Repeated removals produce the same logical
tombstones; compaction applies them. Keep tombstones at least as long as matching index files **and** every possible retry/redrive
horizon; removing them too early can resurrect an erased entry. A removal tombstone logically masks entries immediately but does not
physically erase their PII from old Parquet bytes. Erasure must compact/rewrite affected files, publish and verify the new manifest,
and delete old versions/objects, tombstones and relevant backups when safe before claiming physical index erasure. Handle bucket
versioning, caches, snapshots and PITR; a delete marker alone does not erase old versions. If another retry can still recreate a masked
file, completion is blocked by the queue gap above. Archive deletion calls `remove` on archived IDs; retention deletes closed days
older than the active-store retention cutoff only after archive commit / lease checks. Archived events are searched via the archive's
reduced-key columns, not this active index. Late old deliveries must be suppressed or individually indexed until safe; do not expire
their only index before they are archived or deleted.

## Requested erasure protocol and race table

1. Persist an erasure request and a **durable, strongly readable suppression** for the reduced
   selector keys covering events with `receivedAt <= requestedAt`, before closing the fence.
   On every queued delivery, check suppression before rate limiting; if suppressed and the
   event is already in the active store, delete it and remove its index entries before ack.
   Check all active reducer/pepper versions. Keep suppression through the full queue/DLQ replay
   horizon; if replay is unbounded, retain it or reject replay of older messages.
2. Use K=8..16 deterministic project fence items, selected by hash of event ID. A writer reads
   its fence value **before** reading suppression, then its event TX condition-checks that same
   value when erasure is enabled. The request atomically closes/advances all K items in one
   transaction after suppression is durable. Thus a writer with the old fence cannot commit
   after closure; a writer reading the new fence must then see suppression. Strong reads and no
   stale suppression cache are required. This is O4's extra ConditionCheck only when enabled.
   Concurrent closures condition/retry safely. It does not depend on read-only
   ConditionCheck/ConditionCheck transactions being conflict-free: retries are bounded and
   exhaustion is retryable, not data loss. Verify actual conflict rates on real DynamoDB.
   SQL and memory implementations need equivalent atomic transaction fencing. A failure to
   establish the suppression/fence ordering keeps the request pending.
3. Wait at least queue visibility timeout + function timeout after the fence; hold the project's
   archive lease, finish any staged archive batch to commit, then `lookup` all subject keys /
   versions through `requestedAt` and delete returned active IDs with `deleteBatch`; write
   tombstones with `remove` and clean overflow blobs. Repeat until **two consecutive complete
   passes** are empty. Idempotently repair latest-event pointers only; never decrement the
   all-time issue count. After active purge use `archive.deleteWhere` with reduced keys and
   continue the existing mask/hard-erase/snapshot-expiry protocol.
4. Do not mark complete while a DLQ contains a message older than the request; inspect and
   preserve original message metadata rather than use DLQ age as original `receivedAt`. The
   Queue port currently has no exact inspection facility; add a platform-specific capability
   and fail closed when unavailable. Also resolve the main-queue gap at the top before claiming
   completion. Two empty index passes are a check of the files visible in those passes, not a
   certificate of all messages ever accepted.

| Race | Intended catch and remaining limit |
| --- | --- |
| Queued at request time, not committed | Durable suppression is checked on delivery; suppress/purge before ack, including DLQ redrive. Until the queued work is resolved, an empty index is not proof of completion. |
| Mid-`recordEvent` at fence | Old shard condition fails if closure wins; if write wins it is a committed pre-fence event. Read fence before suppression so a new-fence writer cannot use an old suppression read. |
| Committed before fence, not yet indexed | The wait covers an in-flight invocation; redelivery appends or suppressed retry purges. A message delayed/retrying in the main queue after the wait may escape two passes and not yet be in DLQ: **completion blocker**. |
| In a staged archive batch | Hold archive lease, complete the staged batch first, then mask archive using reduced keys; no later staged commit may reintroduce it. |
| Arrives after request | New writer sees suppression and drops `receivedAt <= requestedAt`; newer events are permitted by that request's boundary. Keep suppression over all redrive/replay horizons. |
| Index append races compaction / erasure | Append has immutable content-derived name; compaction removes only captured inputs after manifest CAS. Tombstones mask late copies; serialize lookups/compaction with the lease, but the queued-work blocker still applies. |

## Access requirements and example cost

Introduce a distinct blob purpose `subject-index` with prefix-scoped policies, not a DynamoDB resource or grant. Core requirement
tables, bindings, manifest capability validation, S3 policies / FS and R2 implementations, Terraform output keys and deployment tests
need updating when stage 4 is implemented. S3 `read` already includes prefix-scoped `ListBucket` for missing-key disambiguation;
reflect the concrete extra list permission in the IAM policy.

| Role / operation | Abstract `blob` capabilities on `subject-index` | Notes |
| --- | --- | --- |
| consumer append | write | Per-project/day file publication before ack; suppressed duplicate cleanup may need the erasure-worker permissions below. |
| cron compaction / retention | read, write, delete, list | Read source/tombstones, publish compact+manifest, delete inputs and expired files under lease. |
| erasure worker | read, list, write | Lookup and tombstone; physical rewriting/deletion can be delegated to cron with a durable completion check, or grant delete if the worker does it itself. |
| archive worker removing active index entries | write | Tombstone archived event IDs; coordinate with archive lease. |

Also grant metadata CAS for the per-day manifest, suppression/fence storage, and archive / active-store / primary-blob permissions to
the roles that actually perform those operations. A consumer that purges suppressed duplicates needs delete access as well; role-scoped
grants must reflect the selected implementation, not the smallest illustrative table alone. The S3 prefix policy must not grant general
access to envelopes, artifacts or archive staging.

For 1 million events/day, 50 projects, 30 active days, assume **10 events per project/day batch**, all events indexable, no retries,
and 1,000-object LIST pages. Mixed-project/day batches yield more files, while larger batches reduce them:

- Append: 100,000 small files / PUTs per day, **3 million PUTs and files over 30 days** before
compaction. At illustrative S3 Standard $0.005 per 1,000 PUTs, ~$15 for those PUTs. Four indexed fields make
~40 rows/file; they do not make four object PUTs per batch.
- One project's 30-day lookup before compaction: 2,000 files/day = 60,000 files; with each
day listed separately, about **60 LIST requests** and **60,000 GETs** if each small file is read once,
excluding tombstones / continuation retries. Illustrative request cost ~$0.0003 LIST + ~$0.024 GET. More
ranges/HEADs, duplicates, mixed batches and 31 touched calendar days raise this. Listing all projects for an
operation is 50 times the per-project work.
- After full compaction: 50 projects * 30 days = **1,500 compact files / PUTs per 30 days**,
plus ~3 million source-file GETs and deletes to compact those files once. A single-project 30-day lookup has
~30 LIST + ~30 footer/metadata GETs, **plus** matching / false-positive row-group and bloom-filter range GETs
and tombstone reads. The exact GET count depends on row-group size, number of columns/ranges, multiple keys,
late append files and false-positive rate; it can be much larger than 30. Bloom/statistics pruning must never
skip a match.
- At the same prices, 3m compaction GETs add ~$1.20, 1,500 compact PUTs ~$0.0075, and source
deletes are free in the illustrative S3 class; 1,500 or more paginated LISTs, manifest CAS / puts, tombstones,
retries, storage, transfer, CPU and late-file recompaction add cost. These are estimates from [S3
pricing](https://aws.amazon.com/s3/pricing/), not whole-system costs. Use range-read measurements and actual
pagination rather than treating one compact file as one request. Non-S3 adapters have different economics;
blob-fs listing may scan a local directory even though no DynamoDB Scan is used.

## Rate-based rejection (stage 3)

Choose per-issue/per-window fixed-window `KV.increment` after suppression; the decision occurs in the consumer after the SDK already
received HTTP 200, so it cannot return an `X-Sentry-Rate-Limits` response for that event. A separate earlier project limit is possible
but cannot know a fingerprint without changing ingest. Default issue limit and per-project new-issue cap are **disabled** until
configured; stack provides bounded defaults/ceilings and projects may override within them. In `batched` mode count events per issue in
the batch and increment once by that count; if only part fits the budget, deterministic input order decides which are accepted. Fixed
windows permit boundary bursts; clocks, distributed KV contention and retries affect precision. A rejected event is acknowledged, not
stored, never advances `lastSeen` and cannot cause a regression/notification.

For each rejected event increment a per-project/issue/window KV dropped counter and surface it as a **windowed, approximate** API
field, separately from `Issue.count`. No durable rejection ledger: increments lost on a crash are accepted (retries are no longer
double counted, see the 2026-11-25 note below); this must not be labeled an exact total. Issue list and detail responses expose `approximateDropped` with `count`, `windowSec`,
`windowStart`, `windowEnd` and `timeBasis: "receivedAt"` while a limit is enabled. The window is
aligned to UTC epoch boundaries using the issue limit's window when configured, otherwise the
new-issue cap's window. Each drop is charged to its original ingest `receivedAt` bucket; delayed
or replayed events can update an old bucket and therefore be absent from the current-window API
count. This matches admission accounting and avoids moving retries between buckets, at the cost
of understating delayed drops in the current window. Keys have a two-window TTL from creation.
A missing key means zero; a KV failure or invalid value omits the field rather than failing the
request. Counts can be over- or under-reported as described above. Fail open on KV failure by default and emit an aggregate failure metric without PII;
per stack an operator can choose retry instead. Project-level new-issue cap limits rotating fingerprints. The existing KV has no atomic
"first fingerprint in this window" operation: if cap decisions count candidates that observe an absent issue, simultaneous candidates
and retries can overcount. This is a conservative approximate cap, not an exact unique-issue quota; using a durable dedupe ledger would
contradict the cut. A project with a hard quota needs a separately reviewed atomic primitive. Count the issue-rate increment before
rejection; project-cap and dropped-count increments add further KV requests. A previously persisted duplicate should be recognized
without re-bumping its issue. Superseded 2026-11-25: counters are charged exactly once per event (issue limit) or per issue and window (cap) through marker and outcome keys, so redelivery no longer double-charges; see ARCHITECTURE.md.

At 1m events/day and 12 WRU/event baseline, one <=1 KiB DynamoDB KV write per event adds about 8.3% write units; the current
`kv-dynamodb` also performs a strong read per increment and can retry conditional races. Those extra reads, project-cap /
dropped-counter operations and failures cost more. Tests cover window/batch boundaries, failure policy, exact redelivery, project
scope and rotating fingerprints, suppression first, rejected regression, and API freshness/expiry; no sampling or rejection-ledger
tests should be added.

## Consolidated core/domain/contract changes by implementation stage

### Stage 1 — deployable DynamoDB store, common erasure unavailable

- Add `EventRepo.capabilities.deleteBySubject: false` (or an equivalent named capability) to
all stores and route the erasure API to a clear unsupported error; retain the old method as a migration shim which always throws and never invoke it. SQL sqlite/Postgres and memory must not provide a bypass. Remove the
method entirely in stage 4.
- `Issue.count` JSDoc and API field description: accepted event insertions ever recorded;
archive/retention/erasure never decrement. Keep `repairAfterErasure` unavailable until stage 4 rather than
exposing the old subtraction semantics. Migrate existing SQL and memory tests.
- Page/`EventQuery`/`EventPage` JSDoc and cursor shape: last examined per GSI stream, including
zero-result continuation; preserve source-local cursor separately from federation's global
`(receivedAt,eventId)` keyset. Test stale-only pages, prefetched shard rows, empty progress, ties, direction,
filters, invalid cursors and cross-adapter parity.
- Replace the single bundle put with a manifest-based lifecycle. Proposed shape:

```ts
type BundleState = "pending" | "active";
type BundleManifest = { blobKey: string; digest: string; debugIdCount: number };
interface ReleaseRepo {
  beginBundle(bundle: ArtifactBundle, manifest: BundleManifest): Promise<void>;
  putBundleDebugIds(projectId: ProjectId, bundleId: ArtifactBundleId,
                    debugIds: readonly string[], manifestIds: readonly string[]): Promise<void>;
  verifyAndActivateBundle(projectId: ProjectId, bundleId: ArtifactBundleId,
                          manifestIds: readonly string[]): Promise<void>;
  deleteBundle(projectId: ProjectId, bundleId: ArtifactBundleId): Promise<void>;
  findBundleByDebugId(projectId: ProjectId, debugId: string): Promise<ArtifactBundle | null>;
}
```

`ArtifactBundle` gains state/manifest metadata. Idempotent chunks, pending TTL and final conditional activation are described in the
DynamoDB design; lifecycle tests include thousands of IDs, retry, conflict, crashes and the TTL-clearing caveat. Blob manifest access
requires appropriate core requirement rows. Also add role-scoped `metadata-delete` as described there; SQL/memory implement the common
capability semantics without IAM. Add schema migration tests.

### Stage 2 — batch writes

```ts
type RecordInput = { occurrence: Occurrence; event: StoredEvent };
type RecordResult = { inserted: boolean; issue: Issue; isNew: boolean; isRegression: boolean };
interface ActiveStore {
  recordEvent(o: Occurrence, e: StoredEvent): Promise<RecordResult>;
  /** Homogeneous bounded issue group; all new items and issue update commit atomically. */
  recordEvents(group: readonly RecordInput[]): Promise<readonly RecordResult[]>;
}
```

Require same project/issue/fingerprint, reject oversize before write, deterministic per-input results and one transaction per bounded
group. Update SQL sqlite, Postgres and memory as well as DynamoDB and the consumer. Shared contracts cover duplicate combinations, one
isNew, regressions, concurrent groups and whole-group rollback; partial commits across separately submitted groups and ambiguous
transport outcomes belong in adapter fault-injection tests.

### Stage 3 — portable rate limits

```ts
type RatePolicy = { maxEvents: number; windowSec: number;
  maxNewIssues?: number; onKvError?: "allow" | "retry" } | null;
interface Project { /* existing fields */ issueRatePolicy?: RatePolicy }
// API issue output adds the approximate per-window dropped count and window bounds.
```

Add stack default/ceiling and project-override schemas, `KV` consumer read/write and API read requirements, response shape and the
fixed-window contract above. Null/off is default; `onKvError` defaults to allow + metric. Implement/test with memory and DynamoDB KV
and any other selected KV adapter. No sample policy or rejection ledger.

### Stage 4 — index, suppression and erasure

Add the `SubjectIndex`, `SubjectReducer`, `SubjectEntry` and archive selector signatures above, blob consistency capabilities and
per-day manifest CAS; add an optional K-sharded fence check to `recordEvent(s)` transactions **only when erasure is enabled**, with
equivalent SQL/memory semantics. Add `subject-index` blob policy rows, runtime construction and compaction cron; update consumer ack
behavior, duplicate indexing, retention and archive removal. Remove `EventRepo.deleteBySubject` entirely and change
`IssueRepo.repairAfterErasure(projectId, issueId)` to best-effort pointer repair with no removed-count argument and no count change.
Update `ArchiveStore.deleteWhere` to accept reduced keys, SQL sqlite/Postgres, memory, DynamoDB, archive and every shared contract.
Tests include append regrouping, duplicate redelivery, small/compacted files and bloom false positives, concurrent append/compaction
and lease loss, crash before/after manifest CAS, tombstone resurrection, physical file deletion, retention, pepper rotation,
suppression/fence ordering, DLQ/main-queue counterexample and archive-stage races. Do not mark a request complete until the completion
blocker is resolved or its guarantee explicitly narrowed.

## Later optional yesnodb adapter

[yesnodb](https://github.com/moriyoshi/yesnodb) is a pre-release persistent Rust inverted index mapping 64-bit keys to sets of 64-bit
ordinals, with Roaring-style containers and Arrow Flight. It suits a long-lived disk-backed process (standalone/container/Kubernetes),
not the serverless function default. errtraq's event IDs are 128-bit and have no stable 64-bit ordinal space; a future adapter needs
collision-safe mappings and possibly a per-project ordinal, which the proposed port permits but does not require. yesnodb documents no
conditional writes or durable mutation idempotency keys; retrying an insert after an intervening delete can resurrect it. Reads are
snapshots, not automatically linearizable; bind a read to the committed version when read-your-write is required, and handle snapshot
expiry. It could also help the unresolved issue-tag/faceted-search TODO, but neither that adapter nor tag search is part of M3.