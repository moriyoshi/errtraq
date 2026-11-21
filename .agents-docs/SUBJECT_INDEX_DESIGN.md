# Subject reduction, background indexing and hot-issue policy (M3e step 1b)

Status: design for review. This proposes cross-adapter changes; none are implemented. It
updates the erasure and consumer architecture only after owner review. The DynamoDB-specific
layout and operation map are in [DYNAMODB_DESIGN.md](./DYNAMODB_DESIGN.md). Proposed
TypeScript below is illustrative, but signatures and semantics are intended as the complete
contract-change checklist. There is no claim that a timestamp or an eventually consistent GSI
alone can prove that all earlier writes were indexed.

## PII reducer: choices and recommendation

Reduce each of `user.id`, `user.email`, `user.username`, `user.ipAddress` in core after
normalization and before making index work. Apply exactly the same versioned reducer to a
selector; domain-separate HMAC-SHA-256 by tenant/project, field, reducer version and normalized
value. The pepper is a secret-store value obtained by `SecretSource`, never a stack literal,
Terraform value, environment output, log message or raw index key. Use WebCrypto, constant-time
verification where needed, and length-framed UTF-8 inputs. HMAC keys are still personal data
for access control and retention; pepper compromise enables guessing and equality correlation.

| Configuration | Index behavior | Storage / disclosure trade-off |
| --- | --- | --- |
| `hmac` | Normalize then keyed digest. Recommended for each enabled field. | Preserves exact-match erasure without raw identifiers in key material; loses plaintext search/display if raw fields are not retained. |
| `ip-prefix-hmac` | Canonicalize IP, then truncate IPv4 /24 or IPv6 /64 before HMAC. | Groups many people: a prefix match cannot uniquely identify the person and **must not be treated as exact erasure**. Recommend analytics only, not an enabled `ipAddress` selector unless caller explicitly requests group erasure. |
| `none` | No key generated. | No erasure by that selector; reject clearly as unsupported at request creation. Other indexed selectors and event IDs still work. |

Normalization must be deterministic and versioned: trim and Unicode-normalize strings with an
explicit chosen form; email domain case-folding and IDNA need a defined implementation. The
local-part is not universally case-insensitive. Recommend conservative normalization: trim,
normalize domain and lowercase domain only, preserve local-part case; a project may explicitly
choose case-insensitive local-parts with a documented collision / over-erasure risk. Preserve
case for user ID and username by default. Parse IP as IPv4/IPv6 to canonical binary; collapse
IPv4-mapped IPv6 only by an explicit versioned rule. Reject malformed values rather than
produce a misleading key. Preserve absence separately from empty value. A `none` field is not
silently replaced by a different selector.

**Store raw versus reduced:** recommend independently configurable per-field
`storage: "raw" | "reduced" | "drop"`, default **drop** for IP and **reduced** for user ID,
email and username. Enable **raw** for any field only after an explicit product/privacy review. `raw` supports
UI display but PII must be removed from promoted columns, event JSON, payload blobs, staged raw
envelopes and archive files/snapshots/backups. `reduced` supports equality but cannot display
or recover the original; it remains pseudonymous personal data. `drop` removes that promoted
field, but the reducer may still index the value computed transiently before deletion if
`index: hmac`; this distinction is explicit. The raw incoming envelope and arbitrary nested
payload may contain the same PII: changing promoted fields **does not sanitize the payload**.
A real privacy guarantee requires a separate payload scrubber, raw-envelope lifecycle and
archive rewrite policy; do not claim that `drop` alone erases PII. The archive receives the
same configured representation and reducer version for promoted columns and the same scrubbed
payload, not a different adapter-specific transformation. Any raw mode requires policy
approval and documented retention, access and deletion semantics.

Pepper rotation uses immutable key IDs / reducer versions: make the new version write-active,
continue query/suppression for all old read-active versions, and reindex under a barrier while
keeping old secrets available. Backfill needs original normalized values, which are unavailable
if they were dropped or only old HMAC is retained: either dual-write before removal and retain
the old pepper until all old data/queue/archive retention expires, or explicitly refuse full
rotation / selector support for that historical interval. Never HMAC an old digest as though it
were a digest of the original. Compromise or emergency destruction of the old pepper can make
old entries unsearchable; report affected ranges and fail closed. Changing normalization or IP
prefix is a new version with the same migration constraints.

## Trigger comparison and chosen builder

- **Consumer queue topic (recommend):** portable to SQLite, Postgres, memory and DynamoDB;
  independent retry and horizontal workers. Queue is at-least-once/unordered and may expire or
  DLQ, so it is a wake-up mechanism, not proof of completeness. Admission ledger / repair
  below is mandatory; a producer crash between store commit and publish is recoverable.
- **DynamoDB Streams:** efficient commit-ordered change feed without producer publication, but
  AWS-specific, shard resharding / retention and outage recovery are required, no direct SQL
  equivalent, and Streams alone cannot prove old DLQ work complete. Optional optimization after
  its cursor and recovery contract is demonstrated, not the portable source of truth.
- **Periodic recent-event sweep:** portable only if every adapter can enumerate all committed
  events with a provably complete strong cursor. It adds repeated reads; a DynamoDB GSI scan
  cannot certify completeness and an arbitrary time lookback loses late events. Use a bounded
  reconciliation sweep of the durable work ledger, not a filtered event scan per erasure.

Recommend a dedicated `subject.index` queue topic and worker, plus a durable, strongly
consistent admission/work ledger with idempotent records. A queue publish after `recordEvent`
is retried before acknowledging its original delivery; on a crash between store commit and
publish a ledger sweeper recovers the work. Also publish/recover after a duplicate result if
its indexing work is not complete. Store a task ID based on `(projectId,eventId,generation)`;
workers re-read the authoritative event, derive indexed keys and write idempotent entries, then
mark the task complete only after every entry is durably committed. An event deleted in between
is handled by the deletion protocol below, not indexed back into existence. An event that has
no enabled subject fields still completes a task. Queue delivery ordering does not affect
correctness, and retry/DLQ alarms plus reconciliation remain required.

Each index entry is keyed by `(project, field, reducerVersion, HMAC, shard, receivedAt,eventId)`
and points to issue ID and event location, without payload. Recommend 16 deterministic shards
from event ID, independently query all and merge; a popular shared IP or `anonymous` value then
has bounded logical fan-out and spread writes, not a promise of 16 physical partitions. Index
entry puts/deletes are idempotent. Index rows need an **authoritative strongly consistent
lookup path**, not an eventually consistent GSI pretending to be complete; DynamoDB can use
base-table PK `SUBJECT|project|version|field|digest|shard` and sort `(time,eventId)` for these
background-written entries. A separate strongly readable per-event reverse entry records its
subject keys; where durable work is still present, it can supply them. SQLite/Postgres use an
indexed table with transactional unique keys; memory fake uses an ordered map. Indexing writes
are **outside** the two-action event transaction. Topic route, platform triggers, worker
capabilities and IAM are new work; validate them before enabling the feature.

## Completion barrier: admission, suppression and late events

A GSI, SQS approximate depth, a maximum observed timestamp, or "all messages seen so far"
cannot prove that an event with an earlier `receivedAt` is not delayed, in flight, DLQed, or
committed before a producer crash. A wall-clock `T` alone is therefore insufficient.

Recommend a **durable per-project admission epoch / work ledger** with a linearizable fence:

1. Before an event can reach `recordEvent`, core idempotently registers its unique event ID,
   receivedAt, issue and epoch as `pending` in a strongly consistent durable ledger. The
   registration and reading of the project's open-epoch/suppression state are atomic with
   respect to closing that epoch. This may require a new transactional coordination port or a
   per-project admission sequencer; `KV.increment` and the existing Queue port do **not**
   provide it. It is a deliberate new dependency and potential hot-project bottleneck.
2. On erasure request, durably install versioned suppression for all enabled selector keys,
   close an admission epoch at a linearizable barrier, and capture the closed epoch ID and
   requestedAt. Every earlier registration is visible in the ledger; every later admission
   checks suppression before recording. Messages already in the ingress queue but not yet
   admitted are suppressed when finally admitted, including late and DLQ redrives, even if
   their receivedAt predates the request. Keep suppression for the maximum redrive horizon or
   indefinitely if messages can be reintroduced without a bounded horizon. An arbitrary TTL
   or user-supplied historical timestamp cannot safely shorten this period.
3. The reconciler drains every closed-epoch registration to terminal `indexed`, `suppressed`
   or explicitly `not committed`. A crash before/after store commit is reconciled by a strong
   event-ID read; racing commits require a fenced state transition or a transaction spanning
   admission and event status. Do not mark `not committed` while an old writer can still
   commit: revoke its fencing token and wait for its bounded lease / completion, with a store
   condition preventing stale commits. The two-action DynamoDB issue transaction needs its
   issue/event condition to participate in that fence, or an equivalent port guarantee;
   this is **not yet demonstrated**. Until then the barrier is blocked, not "complete".
4. Only when every admitted task through the closed epoch is terminal, all entry writes are
   acknowledged on the strong index, and any old writer is fenced may the coordinator advance
   a durable `indexedThrough` certificate `(epoch, requestedAt, reducerVersions)`. It may lag
   without bound on outage, expired DLQ or unresolved work. Expose lag / age metrics and alarms;
   recommend a 60-second operational target, **not** a correctness bound. Reconciliation must
   preserve the ledger longer than all retries, archive/erasure operations and retention.
5. The erasure worker, holding the existing project archive lease, finishes/reconciles any
   in-flight staged archive batch, waits for or drives the certificate past its captured epoch,
   queries every subject shard and retained reducer version through `receivedAt <= requestedAt`,
   verifies authoritative base events and deletes bounded pages. With the suppression fence,
   a late old event cannot appear outside this set. Existing architecture's archive lease also
   prevents a staged batch from being committed after the archive mask.

**Review blocker:** A read of an external epoch followed by the prescribed two-action
DynamoDB transaction does not itself prevent a stale writer from committing after the epoch is
closed. Adding a DynamoDB `ConditionCheck` guard is a third transaction action and can create
a hot project key; implementing the ledger inside the same event item without a guard does not
close the race. Alternatives are (a) add the condition check and accept changing R2's exact
shape, (b) a linearizable admission service that leases and fences every writer with a proven
commit protocol, or (c) quiesce writers and wait for verifiably terminated in-flight work.
Recommend **(a)** as the smallest provable choice when erasure is enabled, and keep the
two-action transaction when it is disabled, subject to explicit owner approval. Shard guards
only with a real cross-shard closure protocol; merely hashing them makes closure non-atomic.
This exception conflicts with the literal two-action requirement but is necessary for an
honest completeness claim; no implementation should assume it away.

Bootstrap/backfill of pre-existing data requires a separate authoritative inventory: SQL can
use a repeatable-read database snapshot with write fencing; DynamoDB must have a strongly
consistent, complete inventory path (for example a designed export/backup checkpoint plus a
captured change stream with proven retention), or temporarily quiesce writes and enumerate via
a separately approved base-table process. Neither an eventual GSI nor a background sweep can
prove completeness. Until backfill and catch-up are certified, reject/wait erasure; do not report
success. This is an implementation prerequisite, not an unbounded Scan hidden in an API call.

## Deletion, crash recovery and repairs

Keep the archive lease throughout active purge and archive mask. Query the strongly readable
subject index in bounded pages across shards/versions and lookahead. For each event, a durable
erasure-operation work record records `(requestId,eventId,issueId,payloadBlobKey,indexKeys)`
**before** deletion; deletion is idempotent and subject index entries/reverse entries are
removed idempotently. A stale entry whose event is absent is cleaned without increasing removed
counts. A worker crash after base deletion or index cleanup resumes from the work record, which
retains blob keys and affected issue IDs. Subject entry deletion must not race a pending index
builder: barrier and a tombstone/generation fence prevent re-creation. If transactions cannot
atomically fence the builder and deletion across ports, this is another required coordination
operation, not a best-effort promise. Pending deletion work is reconciled before completion.

Overflow blob keys are also returned best-effort from a page for prompt cleanup, but a durable
receipt is the primary recovery; independently sweep orphaned payload blobs while holding the
project archive lease. The sweep requires a safe age floor longer than any in-flight upload and
a complete authoritative live-reference inventory; a GSI-only absence check is not proof that
a blob is orphaned. Do not delete a blob on a merely eventual negative read. Raw envelopes,
Iceberg masking, hard rewrite, snapshot expiry and PITR retain the caveats in ARCHITECTURE.md.

Issue repair is idempotent **recomputation**, not subtracting a supplied removed count. Under
an issue mutation/admission fence and the archive lease, derive the surviving active IDs/count
and latest from a complete durable ledger / strong subject-independent issue index, and the
archived surviving count/latest from an archive baseline with a proven erasure update; calculate
`issue.count = active + archived` and repoint latest to the max surviving active/archive event
(or retain the prior pointer if none). The DynamoDB issue GSI is a candidate enumeration; its
strongly checked results must match the independently certified active ID set/control count.
If no complete ledger, archive baseline, or required index catch-up exists, return pending; do
not pretend a count query on the eventual index is exact. Repeating the same completed repair
has the same result. If product instead approves count as *active-only*, that changes current
issue semantics and needs a separate architecture decision.

## Per-issue rate policy

**Recommendation:** opt-in per-project fixed-window limit, default disabled; a stack can provide
a default and bounds, with a project override. The consumer knows the fingerprint/issue ID
only after parsing and grouping, so rejection happens **after ingest already returned 200**;
no `X-Sentry-Rate-Limits` can honestly describe this decision for that request. An optional
separate ingest-side project/key limit can return that header, but cannot predict a fingerprint
without moving parsing/grouping into the hot path and changing the architecture.

Use `KV.increment` on a project+issue+window key with TTL established on creation, using
server clock and a versioned window ID. IDs, not raw fingerprint/PII, appear in keys. Config
includes positive integer `maxEvents`, `windowSec`, burst semantics (fixed window allows up to
nearly twice the threshold around a boundary), and policy. `validateStack` checks bounded
integers, known mode/policy, KV increment capability, delivery roles and worker/secret support;
project writes validate an override against stack ceilings. Fail closed with a retryable delivery
on KV failure by default; fail-open is an explicit operator choice with metrics. During a
project setting change, specify the version in the key and accept a new window/burst; clock
skew and independent regions weaken precision.

Recommend **drop above threshold**, not deterministic 1-in-N sampling as a default. Rejected
events are acknowledged after a durable rejection decision and counted in an idempotent,
sharded per-issue `dropped` aggregate exposed separately from accepted issue `count`; do not
insert the event, update first/lastSeen, or trigger a regression/notification. Consequently an
outage storm can hide its newest time or a true regression: report this in UI/API and metrics.
Accepted samples, if an operator chooses `sample { every:N }`, follow normal occurrence rules;
the separately counted dropped total remains approximate until its durable aggregate catches
up. An issue that has only rejected concurrent events needs a pending summary or another
explicit representation; do not create an issue with a false accepted count.

A retryable delivery must reuse its persisted decision; index it by event ID so duplicates do not
increment the dropped counter twice. However KV increment and a durable decision are not a
single transaction: a crash after increment but before storing the decision can charge the
window twice. Recommend documenting this as conservative approximate admission and testing the
crash point; exact token accounting requires a new atomic limiter/idempotency port or shared
transactional backend. Likewise dropped totals require durable dedupe and sharded aggregation,
not a counter increment in a best-effort queue callback. Rate limiting protects issue/GSI hot
keys at the cost of loss, KV load and window-boundary bursts. Never falsely promise exact limits
or exact counters during a partition.

## Consolidated proposed core changes and contract cases

These are **changes to be reviewed**, not current exported declarations. All examples use
branded IDs/types already in core where available. The SQLite and Postgres SQL store and the
memory ActiveStore fake must implement all changed ActiveStore operations; queue, consumer,
archive, testing fakes, all other stores and platform build/requirements must change where
indicated. Contract fakes must not simulate eventual index completeness with a wall clock.

### 1. Batched record and explicit results

```ts
type RecordInput = { occurrence: Occurrence; event: StoredEvent };
type RecordResult = { inserted: boolean; issue: Issue; isNew: boolean; isRegression: boolean };
type RecordOutcome = { ok: true; result: RecordResult } |
  { ok: false; error: "retryable"; reason: string };
interface ActiveStore {
  recordEvent(o: Occurrence, e: StoredEvent): Promise<RecordResult>;
  recordEvents(batch: readonly RecordInput[]): Promise<readonly RecordOutcome[]>;
}
```

Results correspond one-for-one to input, including repeated IDs. `recordEvent` is the one-item
case; successful inserted event+issue bump is atomic; duplicates change nothing. Each issue
batch has deterministic input-order new/regression ownership; groups/chunks may partially
commit. `issue` is a post-commit strong read that may contain concurrent later changes, not a
transaction snapshot. Retryable errors never say an uncommitted event was inserted. Tests:
empty / mixed projects, same-ID duplicates in same/across batches, input mismatch, 40+ concurrent
same-issue events, late timestamps, ties, resolved races, >99 and >4 MiB chunking, partial
commit/retry, cancellation reasons, crash/ambiguous token, independent issues, admission fence.
SQL uses one database transaction per bounded issue group with stable lock ordering; memory
fake implements the same semantics. The consumer groups deliveries only after normalizing and
preserves per-message ack/retry. Confirm notification delivery semantics on ambiguous commit.

### 2. Issue list consistency and rate policy

```ts
type IssueRatePolicy =
  | { mode: "off" }
  | { mode: "drop"; maxEvents: number; windowSec: number; onKvError: "retry" | "allow" }
  | { mode: "sample"; maxEvents: number; windowSec: number; every: number; onKvError: "retry" | "allow" };
type StoreWriteMode = "per-event" | "batched";
interface Issue { /* existing fields */ droppedCount?: number; droppedCountAsOf?: Timestamp }
interface Project { /* existing fields */ issueRatePolicy?: IssueRatePolicy }
```

Stack defaults and project overrides, merge/ceiling and validation must be explicit schema
changes; counts use a new durable `IssueRejectionLedger` with idempotent `(project,eventId)`
decisions and sharded aggregate read, not the exact accepted occurrence counter. Add an
approximation/freshness marker. `IssueRepo.list` JSDoc: GSIs may lag, even after strong base
hydration; count order may use a delayed index key, and the 10-second refresh target is not a
maximum. Every adapter must either honor this weaker minimum or advertise stronger consistency.
Tests cover threshold, window boundaries, max/burst, replay, crash between increment/decision,
clock skew, KV failure policy, missing issue, scope isolation, accepted/rejected regression,
sampling determinism, exact count vs delayed rank, trailing refresh, stale/missing index rows
and config rejection. SQL/memory may implement immediate count order; DynamoDB must pass eventual
consistency contracts using explicit index advancement and never a sleep-based guarantee.

### 3. Reducer and subject indexing

```ts
type SubjectKind = "userId" | "email" | "username" | "ipAddress";
type ReducedSubject = { kind: SubjectKind; version: string; key: string };
interface SubjectReducer {
  reduce(project: ProjectId, subject: { kind: SubjectKind; value: string }): Promise<readonly ReducedSubject[]>;
  supported(project: ProjectId, kind: SubjectKind): Promise<boolean>;
}
type SubjectRef = { projectId: ProjectId; eventId: EventId; issueId: IssueId; receivedAt: Timestamp };
interface SubjectIndex {
  put(ref: SubjectRef, keys: readonly ReducedSubject[], taskId: string): Promise<void>;
  remove(ref: SubjectRef, taskId: string): Promise<void>;
  find(project: ProjectId, keys: readonly ReducedSubject[], before: Timestamp,
       cursor?: Cursor, limit?: number): Promise<Page<SubjectRef>>;
}
type IndexCertificate = { projectId: ProjectId; closedEpoch: string; through: Timestamp; reducerVersions: string[] };
interface SubjectIndexCoordinator {
  register(input: RecordInput): Promise<{ taskId: string; epoch: string; fence: string }>;
  closeAndSuppress(projectId: ProjectId, selector: SubjectSelector, at: Timestamp): Promise<{ epoch: string }>;
  advance(projectId: ProjectId, epoch: string): Promise<IndexCertificate | null>;
}
```

`SubjectIndex.find` is strongly complete **only within a completed certificate** and under its
fences; it is not an eventually consistent query. `SubjectIndexCoordinator` signatures above
are a starting surface, **not a proved atomic implementation**: the event commit needs to
consume/verify the fence, closed epochs need durable enumeration of all registered tasks, and
stale leases must be uncommittable. Add explicit `complete`, `reconcile`, `fence` and
`retire` operations once the cross-store transaction design is chosen. The `RecordInput` must
carry the resulting admission token when this feature is enabled. Extend `StoredEvent` and
archive row schema with stored field representation, reducer version and index task reference;
never store raw PII in index keys. Add stack schemas for per-field normalization, mode, secret
reference and rotation versions, plus required topic/worker bindings. Tests include Unicode /
IDNA / IP vectors, absent/empty, collisions and field isolation, disabled selectors, raw vs
reduced payload behavior, secret non-disclosure, pepper rotation, duplicate/late tasks,
popular-key sharding, task crash before/after put, deletion versus delayed builder, missing
queue delivery, DLQ, a stale writer after barrier, backfill, and old queued messages. The SQL,
memory, DynamoDB and future archive implementations must share reducer vectors and the subject
index/coordinator contract. A real fence proof and durable backend are prerequisites for
claiming completeness.

### 4. Erasure and repair ports

```ts
interface EventRepo {
  // Replaces deleteBySubject: IDs come from SubjectIndex after an IndexCertificate.
  deleteBatch(projectId: ProjectId, ids: EventId[]): Promise<void>;
}
interface ErasureWork {
  recordCandidates(requestId: ErasureId, events: readonly SubjectRef[]): Promise<void>;
  pagePending(requestId: ErasureId, cursor?: Cursor, limit?: number): Promise<Page<ErasureWorkItem>>;
  markDeleted(requestId: ErasureId, eventId: EventId): Promise<void>;
}
interface IssueRepo {
  repairAfterErasure(projectId: ProjectId, issueId: IssueId,
    certificate: IndexCertificate): Promise<{ state: "done"; issue: Issue } | { state: "pending" }>;
}
```

`ErasureWorkItem` must include the durable blob keys, subject-entry keys, prior event location,
issue ID, idempotent state and operation/generation fence. The archive lease and baseline are
also required inputs/dependencies, even though not shown as arguments above; refine the API so
it cannot be called without them. `deleteBySubject` is removed rather than left with its old
false completeness semantics. Repair recalculates active plus archived survivors and latest,
never takes removedCount; use a certificate tied to the specific issue snapshot/fence, not a
reusable stale project certificate. `deleteBatch` must schedule or complete subject-index
cleanup safely for archive retention as well as erasure. Tests inject crashes before/after every
write and blob deletion, repeat repair twice, verify no double count, concurrent ingest,
archive staged/commit race, stale GSI, missing base item, subject-index resurrection, backlog
and DLQ, suppressed queued events, snapshot/PITR caveats, per-project isolation and disabled
selectors. Update SQL sqlite/Postgres, memory, DynamoDB, archive orchestration and their shared
contracts; explicitly migrate existing call sites.

### 5. Artifact-bundle lifecycle

```ts
type BundleState = "pending" | "active" | "abandoned";
interface ArtifactBundle { /* existing fields */ state: BundleState; generation: string }
interface ReleaseRepo {
  beginBundle(bundle: ArtifactBundle): Promise<void>;
  putBundleDebugIds(projectId: ProjectId, bundleId: ArtifactBundleId,
    generation: string, debugIds: readonly string[]): Promise<void>;
  activateBundle(projectId: ProjectId, bundleId: ArtifactBundleId,
    generation: string): Promise<void>;
  deleteBundle(projectId: ProjectId, bundleId: ArtifactBundleId): Promise<void>;
  findBundleByDebugId(projectId: ProjectId, debugId: string): Promise<ArtifactBundle | null>;
}
```

Replace `putBundle` or retain it only as a convenience wrapper around this lifecycle; no
adapter may expose partial pending markers as active. The manifest of all expected IDs and
owner/expiry/fencing rules need explicit arguments and a durable storage abstraction before
implementation; an ID list of thousands cannot live unbounded in one DynamoDB item. Add a GC
port/job for fenced abandoned generations. Contract: 1,000+ IDs, chunk retries, duplicate IDs,
conflicting owners, previous active generation during replacement, crash at each phase,
activation validation, delete versus activate, lookup only active, TTL/GC cannot delete active
markers, two projects and adapter parity. Implement lifecycle in both SQL dialects and memory,
not just DynamoDB.

### 6. Cross-cutting coordination and unresolved approval

Add an explicit transactional admission/fence capability and durable per-issue control totals /
archive baseline, or narrow the completeness promises. Decide ownership, TTL, IAM grants,
provider-neutral transaction boundaries, versioned migrations, operator backfill, and whether
the optional third DynamoDB action is accepted. Existing `KV`, Queue and `MetaRepo` alone do
not atomically couple a queue delivery, admission fence, event commit and index completion.
All port changes require shared tests and updates to SQLite, Postgres, in-memory fakes,
DynamoDB and every call site before implementation is declared complete.
