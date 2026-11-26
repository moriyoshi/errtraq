# DynamoDB active-store design (M3e step 1c)

Status: approved direction with the decisions and open correctness questions below. The stage 1 shared contracts, table infrastructure and DynamoDB runtime are implemented;
batched `recordEvents` is implemented; FIFO and the grouped pipeline remain future work.
`ports.ts` and ARCHITECTURE.md describe the current public contracts. The default erasure-index design is independent
of DynamoDB: see [SUBJECT_INDEX_DESIGN.md](./SUBJECT_INDEX_DESIGN.md). No port operation uses
DynamoDB `Scan` or a filtered full-table scan.

## Decisions and concrete issues for review

- Sparse `KEYS_ONLY` GSIs are eventually consistent. Strongly hydrate every candidate and
  check its current scope, filters and sort key; hydration removes stale positives but cannot
  reveal missing index entries. Lists are not snapshots and may temporarily omit new items or
  repeat/miss rows moving across cursors. Project-time uses 1 to 4 stable shards; an issue-time
  query uses one GSI partition. There is exactly one intentional issue-ID pointer per issue.
- `Issue.count` is the number of accepted event insertions ever recorded for that issue;
  archival, retention and erasure do not decrement it. API docs must call it an all-time count,
  not a surviving-event count. Latest-event repair only best-effort repoints the pointer and is
  idempotent. A duplicate does not bump while the event item exists. **Remaining limitation:**
  after its event item is deleted, a redelivery of the same event ID can be inserted and
  counted again. An exactly-once *distinct IDs for all time* interpretation would need a
  retained dedupe record and extra cost/action; the current port and two-action write do not
  provide it. Define queue/erasure suppression and retention horizons before promising more.
- **Exact composite count order requires a count guard.** DynamoDB cannot concatenate/pad the
  result of `ADD count :n` into a string sort key in the same update expression. To maintain
  `countSort = fixedWidth(count) | issueId` exactly, read count `c`, set the computed key for
  `c+n`, perform `ADD count :n`, and condition on `count = c` (or absence for creation). This
  is **not a revision CAS**, but it does compare count, so the previous claim that ordinary
  writes need no count comparison cannot coexist with exact string count ordering. Do not
  silently use stale keys or a numeric-only GSI with unspecified tie order. Measure the
  resulting extra conflicts; the reviewer's 2.7 transactions/event did not establish the cost
  of this additional condition. Alternative multi-attribute keys or an unbounded tie-group
  sort conflict with the selected constraints and need a new decision.
- The stage 1 runtime stores mutable issue fields separately from the original serialized
  issue data. Count-only updates do not rewrite that data or the status index partitions.
  The transaction guards count plus the regression predicate, so a status change that would
  alter the regression decision causes a retry. Old issue items without separate fields are
  upgraded on their next update using a one-time serialized preimage guard.
- **Erasure completion has a separate concrete gap.** A message can commit an event, crash
  before indexing, be retried repeatedly in the main queue, and not yet be in the DLQ when the
  worker sees two empty index passes. The specified wait and DLQ check alone cannot prove the
  event is absent. The stage 4 design describes the prescribed protocol and fails closed until
  the queue can prove a drain or the owner accepts a weaker guarantee. This does not prevent
  implementing stages 1 to 3, but it blocks a claim of completed physical erasure.
- A bundle's expiring pending markers must be made non-expiring before activation. Clearing
  thousands of marker TTLs and activating the bundle is not atomic; an interrupted preparation
  can leave non-expiring orphan markers. The simple resumable manifest cleanup below avoids a
  generation-fenced GC protocol, but cannot promise unconditional crash-safe reclamation if
  the pending bundle/manifest itself expires first. Retain them until cleanup completes and
  test this boundary; do not silently impose a 48-ID limit.

## Keys, items and sparse indexes

Every table item has string `PK` and `SK`. The base event key is a distinct partition key
`EV|project|eventId` / `DATA`; issue is `IS|project|issueId` / `DATA`. These distribute event
items without a fixed set of base-table shards. Other items are org, project, token, release,
bundle, archive state, erasure state, active-key guard and natural-key markers. Components use
collision-free framing; equality hashes are domain separated and verified against the stored
original where appropriate. Validate UTF-8 key sizes (PK <=2048, SK <=1024 bytes) and actual
DynamoDB item size <=400 KiB before writing. Overflow still starts in core at 200,000 raw
payload bytes, which is not itself a proof the final item fits; reject an oversized item
clearly, never truncate. Measure compression of the payload attribute as the main size/cost
lever; JSON and non-payload fields can still exceed the limit.

`KEY|publicKey` / `DATA` makes `getKey` one strong GetItem. Maintain a key-ID ownership marker
and project key-list GSI; changing a public key transactionally moves its direct item and
markers. Strong unique marker items protect org slug, `(org, project slug)`, token hash,
`(project, release version)`, public/key IDs and debug ID. Conditions allow the existing
owner and reject another with `ConflictError`; rename conditionally deletes the old marker.
An active-key guard makes `getOrCreateActiveKey` atomic even with concurrent candidates.

For `issues.getById`, each new issue transaction also creates one immutable pointer at
`ISSUEID|issueId` / `projectId`, guarded absent. Strong `Query` on that PK returns pointers for
all projects, followed by strongly consistent BatchGetItem; it does not wait for a GSI. This is
O3's deliberate exception, not one pointer per event or per sort. Account for the extra action
and WCU only on issue creation. Pointer lifetime matches issue lifetime; all-project lookup
still needs access control by the caller.

Use **one composite string range key per GSI**, not multi-attribute keys. Event time keys are
`T(receivedAt)#E(eventId)`, where T is the exact canonical 24-byte UTC millisecond form and E
is a prefix-safe, order-preserving UTF-8 byte encoding with an unambiguous terminator. Compare
composites directly for `(receivedAt,eventId)`, both directions, with precise exclusive cursor
and `[from,to)` bounds. Issue sort keys scan **forward**: complemented fixed-width timestamp
or `MAX_SAFE_INTEGER - count` as a zero-padded 16-digit decimal, followed by E(issueId). Thus
sort value is descending and equal-value issue IDs ascend. Count is separately stored as a
safe integer `N`. Validate encoding against SQLite, archive, Unicode, prefixes, empty IDs,
range endpoints and ties. Exact `countSort` changes on every accepted event; no refresh job,
dirty index or count-sort lag policy. Eventual GSI propagation still causes temporary lag.
Coalescing **both** last-seen and count sort updates is a possible later optimization only if
real load tests justify changing list semantics.

| Index | PK and SK | Query / projection |
| --- | --- | --- |
| `event-project-time` | `project|shard`, `T(receivedAt)#E(eventId)` | All events / archival; `KEYS_ONLY`; merge 1..4 shard streams. |
| `event-issue-time` | `project|issueId`, same time key | One issue's events; `KEYS_ONLY`; no fan-out. |
| `issue-id` | `issueId`, `projectId`; pending bundles use a separate namespaced project key and expiry / bundle ID sort key | Eventual cross-project issue index and pending-bundle expiry queries; the strong issue pointer prevents a false not-found while this index catches up. |
| `issue-last`, `issue-first`, `issue-count` | `project|status`, respective descending-sort/ascending-ID composite | One per sort, `KEYS_ONLY`; status-less list merges the three status partitions. |
| `entity-list` | `entityKind|scope`, entity-ID key | Projects, keys, releases and bundles by project and release; `KEYS_ONLY`; sparse, scope per operation. |
| `project-org` | `ENTITY|projects-by-org|orgId`, project-ID key | Projects of one organization: `ProjectRepo.listByOrg` is one eventual Query plus strong hydration, `KEYS_ONLY`, sparse, written by `projects.put` next to the `entity-list` pair. Projects written before this index exist need `DynamoStore.backfillProjectOrgIndexes()` (no scan: it pages the global project index and conditionally adds the two attributes; idempotent). |
| `facet-count` | `FV|project|issue|key` (the item's own `PK`), `countSort#E(value)` | UI-d tag facets: the top-N and the value pager of one `(issue, key)` are one bounded Query on one partition, count descending then value ascending; `KEYS_ONLY` plus strong hydration, sparse (only facet value items). See "Statistics items". |
| `erasure-all`, `erasure-project`, `erasure-state`, `erasure-project-state` | applicable global/project/state PK, project/erasure-ID SK | Four `KEYS_ONLY` sparse indexes, one chosen for each metadata filter combination. |

The issue-ID GSI is retained as requested alongside the strong pointer. `getById` uses the
strong pointer as its authoritative path; the GSI is redundant for this operation but is
available for index parity and backfill validation. Its extra write/storage cost is deliberate
and a future simplification can remove it only with a reviewed schema migration. These are
**13 GSIs**, within the default table quota of 20; no count-refresh GSI. Verify quota and
provider replacement behavior. All index attributes are `S`; no multi-attribute GSI key is
required. A `KEYS_ONLY` entry includes table/GSI keys but not event payload or mutable entity
data. Each GSI Query is eventual; BGet in chunks <=100 with `ConsistentRead:true`, retry
`UnprocessedKeys`, restore ordering, then verify current values. Strong reads cannot prove a
missing GSI entry absent. The issue-time key can itself become hot under an extreme fingerprint.

Project-time shard count defaults to **4**, configurable only on an empty/new table and stored
as durable table metadata; existing readers/writers use that value, never silently change it.
At 1 million events/day across 50 projects the overall average is ~11.6 events/sec, only ~0.23
per project/sec; 1 shard is a valid cheaper choice, 2 or 4 absorb some uneven project traffic.
Each page incurs up to K queries and a merge. Four logical keys are not a throughput guarantee:
physical placement, bursts, event sizes and issue/GSI hotspots still matter. Re-sharding needs
an explicit dual-read/backfill migration, not a mutable runtime flag.

## Pagination rule and consistency

For issue lists, `events.listByIssue`, `scanOlderThan`, entity lists and erasure-state lists,
the opaque continuation records **the last examined index key per stream**, not only the last
emitted result. Refill after stale/deleted candidates until `limit` valid rows have been emitted
or every stream is exhausted; a page of only stale candidates must advance, never loop or end
prematurely. At an execution/time budget boundary, return an explicit continuation even with
zero items. Query pages can prefetch: do not advance a shard's cursor past an unconsumed
candidate; either buffer it in a bounded cursor or resume from its predecessor. Merge by full
composite key and preserve each stream's consumed position. Validate cursor scope, shape,
filter, sort and shard count; retry unprocessed keys, don't report exhaustion on failure.

`EventPage.nextCursor` exposes scoped source-local progress, including empty-but-progressed pages,
while retaining
`EventPosition` for the active/archive federation boundary; the federated merger keeps pulling
empty partial pages before comparing streams and must not use a source cursor as a global
keyset. The change needs a contract test so source-level examined progress never skips
prefetched candidates. Concurrent writes/sort changes can move rows around a cursor; there is
no snapshot or finite GSI propagation bound. `Page.nextCursor` likewise remains non-null when
an execution budget ends before exhaustion.

## Writes, duplicates and bundle lifecycle

### Per-event transaction (stage 1)

The consumer currently calls strong `events.get` before every write; **keep it in stage 1**
so overflow blob behavior is unchanged, and count it below. It is only an optimization: the
conditional event put remains the authority. Read issue strongly, choose a branch from its
actual fields, then `TransactWriteItems`: (1) conditional Put event with attribute absent;
(2) conditional Update issue with `ADD count :one`, exact computed count sort key and guarded
firstSeen / lastSeen / latest / resolution fields; (3) on issue creation only, the conditional
issue-ID pointer Put. With erasure enabled in stage 4, add (4) a ConditionCheck on one of K
fence items. No standalone ConditionCheck targets the same issue item as its Update. Validate
occurrence/event IDs and `receivedAt` match and fingerprint matches an existing issue.

Variants are absent issue, existing newer/equal-tie winner, older event, firstSeen minimum,
and regression; compose the necessary conditions. Regression means current status is resolved
and `resolvedAt` absent or `receivedAt > resolvedAt`; update status only when the guarded
preimage still matches. `if_not_exists` handles creation fields, but conditional SET requires
an actual transaction condition: DynamoDB does not provide arbitrary conditional update
expressions. `ReturnValuesOnConditionCheckFailure: ALL_OLD` supplies an updated issue image
when available; otherwise reread. On event-exists cancellation, strongly read the persisted
event and its real issue, return `inserted:false`, both flags false, no issue update. On an
issue/count/fence race, re-evaluate branch and retry with bounded jitter; retry exhaustion is a
retryable error, never partial success. Use a unique request token per identical transaction;
reusing a token after changing parameters fails. A successful transaction returns no issue
image, so a subsequent strong issue read may include later concurrent updates: define this on
the return type. Unknown commit after the token window can be indistinguishable from another
writer's duplicate; notification certainty is not guaranteed without a separate outbox.

The second reviewer observed exactly one `isNew` and correct counts under 200 and 500
concurrent DynamoDB Local transactions (random, tie, monotone, regression storm and 25
duplicates), around **2.7 transaction attempts/event** under storm. That is useful evidence,
not a DynamoDB Local proof of real DynamoDB contention or of the newly required count-key guard.
Real AWS must test the precise final expressions, bounded retries and hot-index backpressure.

### Batched transaction (stage 2)

The owner selected queue-first grouping: the `record` role receives a FIFO group after the
consumer has normalized an event. With a live visibility lease, one issue has at most one record
batch being processed; an expired lease, a mode transition, redrive, an API update or an external
writer can still overlap. FIFO does not replace transaction isolation or the count preimage guard.
The public contract starts at 1..10 inputs per same `(project, issue, fingerprint)` group; Lambda
FIFO currently uses at most 10 per group. Every input's occurrence/event IDs, issue and receivedAt
must match. The future queue handler validates group key against the computed issue ID and splits oversized
groups into ordered, bounded transactions before calling the store. The future port is:

```ts
interface RecordInput { occurrence: Occurrence; event: StoredEvent }
interface RecordResult { inserted: boolean; issue: Issue; isNew: boolean; isRegression: boolean }
recordEvents(group: readonly RecordInput[]): Promise<readonly RecordResult[]>;
```

The group is atomic for **all new event and issue mutations**. Results correspond to input order;
repeated IDs inside a batch and IDs already committed are no-ops. Only the first copy of a newly
inserted ID has `inserted: true`; exactly the first inserted member that creates the issue gets
`isNew`, and the first member in input order causing a resolved-to-unresolved transition gets
`isRegression`. Each inserted result may return the post-group issue; an existing duplicate that
belongs to another issue returns that actual stored issue, as `recordEvent` does. All duplicates
means no issue mutation. A post-commit read can reflect a later concurrent update. A failed call
commits none of its **new** events unless the response was ambiguous; retry the entire group and
reconcile via event deduplication. There is no promise of partial group commits or exactly-once
external notifications.

Collapse repeated input IDs first, preserving input order and tracking every result position.
Read the issue strongly and construct one `TransactWriteItems`: conditional event puts for each
remaining candidate, one issue update with atomic `ADD count N`, exact count sort key computed
from guarded count preimage, firstSeen minimum, lastSeen/latest maximum by `(receivedAt,eventId)`,
and the input-order regression transition; add the strong issue-ID pointer only on creation.
With M4 erasure enabled, add the applicable fence check. Validate the 400 KiB item and 4 MiB
transaction limits and 100 unique-action ceiling; 10 event puts plus issue, optional pointer and
fence fit the action ceiling, but byte limits still require checking. A FIFO batch can contain
several groups; each group is a separate transaction, not a global all-or-nothing batch.

Do not pre-read every event in the normal batch path. On cancellation, inspect the ordered reason
for **each** conditional event put, strongly read existing event/issue images as needed, remove
confirmed duplicates, recompute the group and issue branch, and retry all remaining new items as
one transaction. A competing writer can insert a candidate during this process; the event and
count guards catch it and cause another retry. A new client request token is required whenever
transaction parameters change; an identical ambiguous request uses the same token. Retry boundedly
with jitter, including throttling and transaction conflicts, and return a retryable error on
exhaustion. Guard conditions on status/resolution prevent a concurrent API update being overwritten.
Tests inject conflict, duplicate races, ambiguous commit and API resolution; SQL sqlite/Postgres
and the memory fake implement the same atomic contract. The FIFO path reduces routine contention;
only the datastore enforces correctness when leases expire or the deployment has overlapping modes.


### Statistics items (UI-d)

Per-issue hourly counts and tag facets are written by the record transaction itself, never
beside it: a duplicate event cancels the whole transaction and so changes no counter, exactly
as it changes no `Issue.count`. Meaning: accepted insertions ever recorded, never decremented
by retention, archival or erasure. Time basis `receivedAt`, UTC. Issues that existed before
the feature simply start counting from zero. Core owns the rules (`packages/core/src/stats.ts`:
the key allow-list `level, environment, release, server_name, browser.name, os.name,
runtime.name`, 200-character values, `statsIncrements`); the adapter only maps them to items.

| Item | `PK` | `SK` | Attributes |
| --- | --- | --- | --- |
| Hourly buckets (one per issue and UTC day) | `HB|project|issue` | `YYYY-MM-DD` | `h00`..`h23` (N, `ADD`), `ttlEpoch` (N) |
| Facet value | `FV|project|issue|key` | `E(value)` | `count` (N), `val` (S), `GSI13PK` = `PK`, `GSI13SK` = `fixedWidth(MAX_SAFE - count)#E(value)` |
| Facet totals (one per issue) | `FT|project|issue` | `DATA` | `v0`..`v6` distinct values, `c0`..`c6` events, per allow-list index (N, `ADD`) |

* Day items pack the 24 hourly counters, so a 30-day read is at most 31 items per issue and a
  `recordEvents` group touches one item per distinct day, not per hour. `ttlEpoch` is the end
  of the day plus 31 days, so every hour is kept at least 31 days. An expired but not yet
  deleted item is harmless: reads are bounded by an explicit range.
* A facet value item's GSI sort key embeds the count, which `ADD` cannot concatenate, so it
  uses the same guard as `issue-count`: a strong `BatchGetItem` reads the current counts, the
  `Update` `SET`s the new `GSI13SK` and `ADD`s, conditioned on the old count (or
  `attribute_not_exists(PK)` for a new value). Every writer of a facet also guards the
  issue's own count in the same transaction, so a facet guard can only fail when the issue
  guard fails too; the existing bounded retry re-reads everything (the facet pre-read is
  repeated on each attempt). The totals item and the day items are unguarded `ADD`s.
* Values are cut to 200 characters and then to 255 UTF-8 bytes, so `E(value)` (hex, doubled)
  keeps `GSI13SK` under 530 bytes. No cardinality cap; the top-N read is `Query facet-count`
  with `Limit`, never a scan of all values. `GSI13` is eventually consistent: candidates are
  hydrated strongly and shown with their current counts (a value that has just changed rank
  can be briefly out of order; a brand-new value can be briefly missing).
* The new GSI is added to `infra/modules/aws/dynamodb/indexes.json` and the HCL test; adding a
  GSI is an in-place update of the existing table (one index per apply).
* Facets are not reached by subject erasure, so the allow-list excludes every `user.*` key,
  URLs and IPs. Do not widen it without an erasure design.

**Transaction budget with the counters (100 actions, 4 MiB).** For a group of `m <= 10` events
of one issue: `m` event puts + 1 issue update + 1 pointer (creation only) + `D` day items
(`D <= m`) + `F` distinct (key, value) items + 1 totals item (+ 1 fence once M4 erasure lands).
`F <= 5 + 6m` because `level` has five possible values and each of the six other keys has one
value per event. Worst case at `m = 10`: `10 + 1 + 1 + 10 + 65 + 1 = 88` actions (89 with the
fence); a one-event call is at most `1 + 1 + 1 + 1 + 7 + 1 = 12`. So the existing split rule
(at most 10 events and 3 MiB of serialized records per transaction, `RecordHandler`) needs no
change. Bytes: a facet update is about 2 KiB (partition key framing, `val`, both GSI keys),
so 65 of them are about 130 KiB, plus 10 day items and the totals item; the 4 MiB check
adds this estimate to the event, issue and pointer sizes, and the 3 MiB record cap leaves
1 MiB for the issue (at most 400 KiB) and all counters. Both limits are also asserted in
`recordEvents` (action count and bytes), and `record-event.test.ts` pins the 88-action case.
Extra WCU: each action is a transactional write (2x), so a typical one-event call
(day + level + environment + release + totals) adds about 5 items, roughly 10 WCU, and each
facet write also rewrites its `facet-count` entry.

### Bundle lifecycle (stage 1)

No 48-debug-ID cap. Store the full immutable debug-ID manifest in BlobStore under a stable
bundle key. Persist a pending bundle with manifest key and expected count/digest; pending bundle
items and manifest chunks have **no TTL**. Write conditional debug-ID ownership markers in
idempotent chunks, each with a pending TTL.
Verify every expected marker strongly, and clear marker TTLs in bounded chunks before a final
conditional activation of the bundle. `findBundleByDebugId` reads marker then bundle and returns
only an active matching owner. A retry repeats chunks/verification; conflicts with another
owner fail clearly. Keep bounded manifest chunk items under the bundle base-table partition,
and enumerate them with strongly consistent queries; the store does not depend on BlobStore
and never relies on an eventually consistent index to enumerate marker ownership. Create each
chunk atomically with its marker writes so interruption leaves a complete recovery record.
A required scheduled cleanup claims expired pending bundles and removes owned markers, chunks and
the manifest; monitor oldest pending age, failures and backlog. On
delete, make the bundle unavailable first, then remove its markers in resumable chunks. Do not hide the TTL-clearing crash gap
identified above, or promise atomic replacement of thousands of markers without a protocol;
concurrent replacement/ownership and cleanup must be tested. The required blob and store
capabilities must be reflected in stack validation and IAM. This is the simple lifecycle, not
the previous generation-fenced garbage collector.

## Operation-to-access-pattern map

Notation: `G` strong GetItem, `B` strong BatchGetItem, `Q` GSI Query then B/validate, `P`
strong base-table Query, `TX` TransactWriteItems, `BW` BatchWriteItem with `UnprocessedItems`
retry. All GSI list operations use the examined-key rule above. One strong read of an item up
to 4 KiB is 1 RRU; eventual index pages use 0.5 RRU per 4 KiB (minimum applies); ordinary writes
cost ceil(bytes/1 KiB) WRU and transactional writes twice that. Each GSI entry written or
removed is billed separately. Costs below exclude contention/retries and use small items;
worst case is the stated 400 KiB item / 100-action, 4 MiB transaction limits per request;
page and input counts have no finite total bound. A failed condition or transaction also costs
capacity. User-visible pages may be eventually incomplete even after hydration.

| Port operation | One access pattern and typical cost |
| --- | --- |
| `projects.getOrg`, `get` | G entity: ~1 RRU. |
| `getOrgBySlug`, `getProjectBySlug`, `getTokenByHash` | G unique marker then G entity: ~2 RRU. |
| `getKey` | G `KEY|publicKey`: ~1 RRU on ingest. |
| `putOrg`, `projects.put`, `putKey`, `putToken` | G existing entity; TX conditional entity + natural markers, and old marker delete on rename. ~1 RRU + 4..8 WRU plus entity-list GSI changes; API role needs metadata delete permission. |
| `getOrCreateActiveKey` | G active guard and current key; TX guarded guard/direct key/markers; retry loser. ~2 RRU + >=6 WRU. |
| `projects.listByOrg` | Q `project-org` partition of the organization and B candidates; one Query per page, no cross-organization filtering. |
| `projects.list`, `listKeys` | Q `entity-list` global project / project-key scope and B candidates; listKeys drains pages. Page cost = eventual Q + one strong item read per candidate. |
| `issues.get` | G project/issue: ~1 RRU. |
| `issues.getById` | P `ISSUEID|issueId`, then B issues and check IDs. ~1 strong Query + 1 RRU/candidate; no GSI lag. |
| `issues.list` | Q `issue-last/first/count`, one status or merge three, then B/validate; lastSeen `[from,to)`. Q per stream + one RRU/candidate; reject text and lastSeen range on other sort. |
| `issues.update` | G issue, conditional UpdateItem guarded against concurrent writes, update status/sort attributes; ~1 RRU + 1 WRU + affected GSI entries. |
| `issues.repairAfterErasure` | Stage 4: Q issue-time newest surviving active event plus B, optionally query archive for newer retained event, conditional update latest pointer only; keep previous pointer if none. Best effort under eventual lag, idempotent and never alters count. |
| `events.get` | G project/event: ~1 RRU. |
| `events.listByIssue` | Q single issue-time partition, or merge K project-time shards without issue; B/validate, composite ranges in requested direction. ~1 or K GSI queries + 1 RRU/candidate. |
| `events.scanOlderThan` | Q K project-time partitions ascending with cutoff exclusive, B/validate and merge. ~K queries + 1 RRU/candidate. Empty GSI is not proof no old committed event exists. |
| `events.deleteBatch` | BW exact IDs in <=25 chunks, retry unprocessed; idempotent. ~ceil(itemBytes/1 KiB) WRU per item plus event GSI removals; archive/erasure orchestration coordinates external index removal in stage 4. |
| `events.deleteBySubject` | Stage 1: optional capability unavailable for **all** stores; reject API request clearly. Remove the method in stage 4 when the common index port is added. No fallback scan. |
| `releases.get`, `getReleaseByVersion`, `findBundleByDebugId` | G release or G natural/debug marker + G active entity; ~1 or 2 RRU. |
| `releases.put` | G old release then TX conditional entity/version markers and old-marker removal on rename; ~1 RRU + >=4 WRU plus GSI. |
| `releases.list`, `listBundles` | Q `entity-list` by project / project+release, B/validate; page cost as above. |
| bundle create, marker chunks, activate, delete | G / conditional writes and manifest blob operations above; O(debug ID count), no fixed 48-ID limit. See stage 1 proposed signatures below. |
| `meta.getArchiveState`, `getErasureRequest` | G scoped item: ~1 RRU. |
| `meta.compareAndSetArchiveState`, `compareAndSetErasureRequest` | Conditional Put/Update with expected-null creates version 0, else expected+1; invalid/mismatched -> `VersionConflictError`. Erasure metadata updates four sparse GSI keys; ~1 WRU + affected index writes. |
| `meta.listErasureRequests` | Q one of four erasure GSIs depending on project/state, then B/validate. Page cost as above. |
| `recordEvent`, `recordEvents` | TX and cancellation/branch rules above, now including the statistics counters ("Statistics items"). Per-event cost example below; batch uses the same conditional transaction rules. |
| `stats.series` | One strong Query per issue on `HB|project|issue` (SK between two day keys, at most 31 items), 10 issues in flight; at most 100 issues per call. No GSI. |
| `stats.tagFacets` | G `FT|project|issue` (totals), then per present key one eventual Q `facet-count` with `Limit` N and one strong B of all candidates (at most 7 x 10 keys). Never reads all values. |
| `stats.tagValues` | One eventual Q `facet-count` page (`Limit` size+1, keyset = last index key) and one strong B of the page. |
| `stats.deleteBefore` | No-op: bucket items expire through `ttlEpoch`; there is no project-wide index of buckets to sweep without a scan. |
| `migrate` | Schema is provisioned by infra; no implicit table scan; explicit versioned migration for future schema changes. 0 data R/W. |

Subject erasure is disabled consistently across sqlite, Postgres, memory and DynamoDB in stage
1; do **not** retain SQL's current direct delete as a hidden optional capability. A single
common unavailable response avoids different security/erasure promises by stack and avoids
shipping a path that stage 4 will replace. Existing in-memory / SQL contracts are migrated
accordingly; non-erasure store functionality stays usable.

## TTL, infrastructure and capability policies

The module uses numeric epoch-seconds `ttlEpoch` as the store TTL attribute, distinct from
the domain's ISO `StoredEvent.expiresAt` string. The KV table keeps its existing numeric
`expiresAt` TTL; module and emulator fixtures use the purpose-specific attribute. Explicit deletion remains primary. Without archival,
an event can have a retention + margin TTL backstop; with archival, set the numeric TTL only
after the archive batch is durably committed, because a fixed margin cannot prove the
no-delete-before-commit invariant during an unbounded outage. Pending debug-ID markers use
`ttlEpoch`, subject to the activation caveat above; pending bundle items and manifest chunks never have TTL,
and permanent/active markers have no TTL. Cleanup cron is required and must be monitored.
PITR/backups can retain deleted bytes until their retention expires.

### Event TTL activation constraints (not yet implemented)

The epoch conversion helper rounds up after adding the retention bound and grace period. It is
not wired to event writes. A safe insertion-time backstop needs a durable project-retention
ceiling: raising retention above the bound used by an existing event would otherwise allow TTL
to delete it early. The ceiling must remain enforced even if the stack setting is later removed;
changing it requires a migration that accounts for existing TTL-tagged events.

A table that has ever received pre-archive TTLs cannot safely switch directly to archival.
Existing event TTL attributes remain after the setting is disabled, and DynamoDB TTL disabling
is asynchronous. A transition must stop relevant writers, disable table TTL and verify that it
is disabled before archival relies on those events; its completion needs durable state so a
subsequent deployment cannot silently re-enable expiration. An archive-enabled stack must not
write pre-commit event TTLs. After a durable archive commit, TTL marking must be tied to the
committed batch and remain compatible with explicit deletion and retries.

Backstop expiry may leak payload blobs when DynamoDB deletes rows asynchronously; the separate
item 3 cleanup protocol must account for this before claiming full payload retention cleanup.
No issue row receives TTL. The operator-facing activation and migration details remain open.

Legacy bundle index repair is exposed as `DynamoStore.backfillBundleIndexes(inventory)` in
`@moriyoshi/errtraq-store-dynamodb/runtime`. Supply explicit `{ projectId, bundleId }` entries in batches
of at most 1,000; there is no scan and the caller must obtain a complete inventory independently.
The method strongly reads each row, skips missing or deleting bundles, conditionally repairs
release and pending-expiry keys and advances the revision. Repeating it is safe; concurrent
changes are reread and retried. It reports updated, unchanged, missing and deleting counts.
It requires table `GetItem` and `UpdateItem` permissions. Incomplete inventories leave rows
unindexed and must not be mistaken for a complete migration.

The module defines the 12 string-key schemas listed above with `KEYS_ONLY` projections, uses
purpose-specific TTL and records shard count in a protected table metadata item. It versions the
redesigned store name as `<stack>-store-v2` so the old table is not reinterpreted in place. Descriptor declares
`textSearch:false`, `lastSeenRangeOnOtherSort:false`, `deleteStrategy:explicit`, and stage 1
subject erasure unavailable. Versioned migration/backfill is needed for an existing table; do
not reinterpret old keys in place. Module output names can remain stable.

- `key-read`: `GetItem` on the table constrained to `KEY|*` with LeadingKeys required; ingest
  uses only `getKey`. `read` grants `GetItem`, `BatchGetItem` and `Query` on the table and
  named GSI ARNs to the API and other roles that need broader access.
- `write`: `PutItem`, `UpdateItem`, **`GetItem`** (issue branch reads) and any required
  transaction item actions, on the table; `Query` on required indexes via read grant. Ordinary
  event recording uses no `DeleteItem`. When the stage 4 fence is enabled, add
  `dynamodb:ConditionCheckItem` to the writer policy.
- `delete`: `BatchWriteItem` on table for event batches, with retry; never assume this action
  can be replaced by `DeleteItem`. Restrict to the roles that delete active events. The policy
  constrains every `dynamodb:LeadingKeys` value to `EV|*` and requires the key to be present;
  this still permits batch puts on event keys, but excludes issues and schema metadata.
- The **API** performs natural-key renames and bundle-marker removal, which need conditional
  `DeleteItem`. Add a distinct `metadata-delete` capability/policy restricted to metadata key
  namespaces where IAM `dynamodb:LeadingKeys` permits it; do not hide table-wide DeleteItem in
  ordinary write. If IAM cannot safely enforce the desired namespace restriction, surface that
  broader grant explicitly for review. Blob manifests need separate purpose-scoped grants.
  The stage 1 module reserves `ORGSLUG|`, `PROJECTSLUG|`, `TOKEN|`, `RELEASE|`, `KEY|`,
  `KEYID|`, `DEBUG|` and `BUNDLE|` as the only metadata-deletion PK prefixes, and requires
  LeadingKeys to be present. Implementations must use these prefixes for deletable metadata;
  changing the encoding requires a policy change. Event and issue keys remain outside this grant.
  Core requirement tables, descriptor output keys and generated-role tests must change together.

## Costs at the review's example scale

Assume 1 million events/day across 50 projects, 30-day steady state, 2 KiB event, <=1 KiB
issue and keys-only GSI entries, one successful transaction per event, every event advances
lastSeen and exact count sort. Use AWS on-demand example prices $0.625/million WRU and
$0.125/million RRU; actual prices/region, item sizes, failed requests and GSI sizes vary.

| Cost component | Monthly quantity and approximate cost |
| --- | --- |
| Per-event write | 4 WRU event TX + 2 issue TX + 2 event GSI inserts + 2 lastSeen GSI key replacement + 2 count GSI key replacement = 12 WRU/event; 360m WRU = **$225**. Extra pointer write for newly created issues is not included. |
| Existing reads | 30m strong issue pre-reads + 30m consumer `events.get`, each <=4 KiB = 60m RRU = **$7.50**; reads after success and pointer/new-issue work add more. |
| Explicit retention | 30m * (2 WRU base event + 2 GSI deletes) = 120m WRU = **$75**, assuming one full cycle and no retries. |
| Optional issue rate counter | One `KV.increment` per event adds ~30m 1 KiB writes = **$18.75**, about **8.3%** of 360m ingest WRU. The current DynamoDB KV also strongly reads before its conditional update: another ~30m RRU = **$3.75**, plus contention/retries, new-issue caps and dropped counters. Batched in-memory counting reduces increments only when its semantics permit; see companion. |
| Index blob requests | At an average 10 events per project-specific consumer batch, 100k immutable file PUTs/day, **3m PUT/month**; plus LIST/GET/compaction costs. A 30-day single-project lookup before compaction is roughly **60 LIST + 60,000 GET**, after a successful closed-day compaction ~**30 LIST + 30 footer GET** plus matching/bloom false-positive range GETs. These are object-store requests, **not DynamoDB WRU**. See companion for assumptions and full counts. |
| Storage / PITR | 30m * 2 KiB base = ~57.2 GiB, plus two 0.25 KiB index entries/event ~14.3 GiB = ~71.5 GiB before overhead, issues and blobs. At illustrative $0.25/GB-month and $0.20/GB-month PITR on 76.8 GB decimal: ~$19.20 + $15.36. Confirm regional billing/backup size. |

Baseline listed write+read+delete+storage/PITR is ~$342.06. + optional counter ~$22.50 before
object-store traffic, index storage, issue creation, Lambda, queue, blobs, archive, network,
read-after-commit, retries and free tier. Actual GSI transactional accounting must be measured.
The earlier unguarded experiment's ~2.7 **transaction attempts/event** includes failures that can consume
capacity; it does **not** mean exactly 2.7x the whole bill, because failure stage/size/index
updates differ. Measure per-action consumed units and p99 with the final count guard. Batch of
10 gives a theoretical 66 WRU / 10 events (40 event TX + 2 issue TX + 20 event-GSI + 4 issue
GSI), before pointer/fence and duplicates, but only for full same-issue groups. Item size
rounding makes payload compression the major lever. Postgres can be cheaper or comparable;
DynamoDB's trade is managed on-demand operation, not an asserted price win. Prices are
illustrative, not a quote: [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/) and
[S3 pricing](https://aws.amazon.com/s3/pricing/).

## Stages and proposed changes by stage

**Stage 1 (M3, deployable store).** Implement the items, markers, strong issue-ID pointer,
per-event transaction, exact count composite, indexes, examined-key cursors, batch deletion,
CAS metadata, simple bundle lifecycle, HCL / IAM. All stores declare subject deletion
unavailable and the API rejects it until stage 4. Contract changes needed now:

```ts
interface Issue { /** Accepted event insertions ever recorded; erasure never decrements. */ count: number }
interface EventRepo { readonly capabilities: { deleteStrategy: "explicit" | "ttl"; deleteBySubject: false } }
interface EventQuery { /* existing fields */ cursor?: Cursor }
interface EventPage { items: StoredEvent[]; hasMore: boolean; nextCursor: Cursor | null }
// The legacy deleteBySubject method remains required but always throws while capability is false;
// callers must not invoke it and the API reports unsupported. Remove it in stage 4.
```

Add JSDoc for examined per-stream cursor and lag; contract cases stale-only page, no looping,
shard prefetch, empty with continuation, ties and malformed cursor, all-time counts and no
subject deletion on each adapter. `IssueRepo.repairAfterErasure` remains unused/unavailable
until its signature changes in stage 4; do not keep a callable decrement path in the API.
Add bundle `pending`/`active` state, manifest reference, begin/chunk/verify/activate/delete
operations and cross-adapter tests for hundreds/thousands of IDs, duplicate chunks, conflicts,
crashes, TTL preparation and activation. Clarify exact input/return signatures in the stage 1
implementation PR; proposed full typed lifecycle is in the companion document. SQL sqlite,
Postgres and memory fakes must honor the capability and changed shared contracts. API docs must
say count is all-time and subject erasure is not yet available. Verify migration versions and
both Terraform provider versions; no Scan.

**Stage 2 (M3).** Implement the queue-first record stage and the 1..10-input `recordEvents`
contract above, with direct/grouped stack configuration. `recordEvent` remains. Implement SQL
sqlite/Postgres, memory and DynamoDB; add grouped queue and retry/visibility tests, partial-failure
tests, and shared atomicity/duplicate/regression contracts. Explicitly enforce transaction size.
See [the per-turn plan](./ISSUE_KEYED_QUEUE_PLAN.md).

**Stage 3 (M3).** Core rate checks on KV, stack defaults/project overrides, per-project new
issue cap, fail-open by default and fail-retry option, API-visible per-window dropped count;
no rejection ledger, no sample policy. Test suppression-before-rate, duplicate overcount,
fixed windows, batch counting, failures, project cap and unchanged lastSeen/regression.

**Stage 4 (M4).** Add reducer, independent Parquet-in-blob index and its compactor, inline
consumer append before ack, durable suppression, K-sharded fence, erasure worker, common
`deleteBySubject` removal, count-preserving pointer repair and archive reduced-key deletion.
See companion for exact proposed port signatures, capability rows and race table. Close the
SQS completion-proof gap before declaring erasure complete.

Explicitly cut the prior admission ledger, epochs, certificates, coordinator, erasure-work port,
archive baseline, rejection ledger, sample policy, count-refresh reconciler/index and
multi-attribute GSI keys. The simple bundle lifecycle does not reinstate generation-fenced GC.

## Emulator and real AWS checks

Winterbaume at the pinned revision exercises ordinary API shape/order and basic conditions,
but its conditional update check/write is not atomic and it cannot establish transaction
concurrency, CAS, fence behavior, index propagation or precise capacity. Probe composite-key
ordering, GSI projection support and failure reasons; bump the pin only after immutable revision
and old gap checks, or use DynamoDB Local for a named missing feature. Local's 500-way result
above remains informative but cannot substitute for AWS transaction contention.

M3h: 500 concurrent same-issue writes in per-event and batched modes, including new count-key
guard, retry/exhaustion rate, exact count and `isNew`, p99 and transaction/GSI consumed units;
GSI throttling backpressure; index projection and examined-key cursor behavior under stale rows;
role-specific IAM incl. `BatchWriteItem`, `metadata-delete` and optional fence; TTL attribute
and archival safety; real `ConditionCheck` vs `ConditionCheck` contention and K-shard closure;
active/archive latest-pointer repair. Stage 4's queue/DLQ proof and object-store assumptions are
separate prerequisites, not established by a successful 500-way test.
