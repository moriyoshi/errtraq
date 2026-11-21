# DynamoDB active-store design (M3e review draft)

Status: design only. No adapter or infrastructure change is implied by this document until
review. `ports.ts`, `domain.ts` and `activeStoreContract` are normative. This design uses the
existing explicit event-deletion strategy. It makes the project-key sketch in ARCHITECTURE.md
more specific: event partitions must be sharded. Review the trade-offs and open decisions below
before implementing it.

## Decisions requiring review

1. **Read correctness versus write cost:** maintain strongly consistent lookup items in the
   base table in the same transaction as their owner, rather than eventually consistent GSIs.
   This uses no GSIs and no `Scan`; it costs more writes and extra point reads. It avoids
   false absence immediately after an insert when archival or erasure queries run. Issue-list
   keysets remain non-snapshot, as the port explicitly allows.
2. **Fixed 16-way event sharding:** hash the immutable event ID to a stable shard. There are
   no time buckets, so late events need no bucket directory and old data is discoverable.
   Every event-range page queries up to 16 partitions and merges them. Changing 16 later is
   a data migration, not a configuration switch. It does not remove the single-issue counter
   hotspot, and physical partition placement and DynamoDB adaptive capacity provide no 16x
   throughput guarantee. Monitor and load-test before promising a rate.
3. **Issue sort indexes are materialized table items:** transactionally replace only changed
   keys. Every list has one read of the index row plus a base issue read. CAS retries can be
   expensive and a pathological hot issue can starve writers. This pays for exact, immediately
   visible sorted keys rather than relying on eventual GSI propagation.
4. **Bundle debug-ID sets have no port limit:** replacing arbitrarily many unique markers in
   one DynamoDB transaction is impossible past its 100 actions / 4 MiB limits. Propose an
   explicitly validated maximum of 48 distinct debug IDs per bundle, including the union of
   old and new IDs on replacement (plus at most two bundle/list actions); reject an oversized
   change before writing. This is a new adapter limitation not expressed by the port and can
   reject otherwise valid data. Do not silently truncate or chunk an atomic replacement. The
   alternative is a reviewed reservation / recovery protocol and a corresponding port and
   contract change. **This decision needs approval before implementation.**
5. **Erasure crash boundary:** one transaction per deleted event keeps its lookup rows
   consistent, but a process crash after committing a deletion and before returning its count
   and blob key can lose that result. `deleteBySubject` has no operation ID or durable receipt,
   so exactly-once count/blob-key delivery across such a crash is impossible under the current
   port; SQL has an analogous commit/response boundary. M4 must specify durable erasure
   receipts or another recovery protocol before claiming crash-safe physical erasure. Likewise,
   separate `repairAfterErasure` is not idempotent if repeated with the same count.
6. **Size boundary:** keep the existing core 200,000-byte raw-payload overflow threshold, but
   it is not a proof that the final DynamoDB item fits: normalized fields, JSON expansion,
   attribute names and metadata count too. Before the first write, measure the actual DynamoDB
   item and reject any item over 400 KiB with a clear size error; never truncate. A complete
   portable overflow policy for oversized non-payload metadata needs a core/port decision.
7. **Emulator pin:** propose a separate, tested pin bump to a specific upstream commit after
   verifying projections and running the existing gap checks; do not silently replace the
   current pinned revision just because upstream main supports projections. This design does
   not require projections, so the bump is useful coverage, not a blocker to its base layout.

## Key grammar and record shapes

All keys below are string attributes `PK`, `SK`. `E(x)` is lowercase hex of UTF-8 bytes,
with a terminator or length framing for each component; equality values such as a subject can
instead be SHA-256 of a length-framed, domain-separated UTF-8 value. Hashes of selector values
are **not** encryption; access to the table and backups remains sensitive. Each stored marker
also verifies its full original value where a collision could otherwise confer ownership. Do
not log selector values, hashes, tokens or payloads. Enforce DynamoDB's 2048-byte PK and
1024-byte SK limits on the encoded bytes before writing. IDs are opaque; do not assume hex or
that concatenation with `#` is unambiguous. The sort order for textual IDs is UTF-8 byte order,
with the same comparator in cursors and tests; validate this against the SQL port's ordering.

`T(t)` is the canonical 24-byte UTC millisecond `YYYY-MM-DDTHH:mm:ss.sssZ` representation,
ordered lexically, including four-digit year boundaries. `C(n)` is a zero-padded 16-digit
integer for `0 <= n <= Number.MAX_SAFE_INTEGER`; reject overflow instead of rounding.
`D(T)` and `D(C)` are bytewise digit complements of those fixed-width values. A sort key
`D(value) | E(issueId)` scanned forwards yields value descending and issue ID ascending,
including equal values. Event `T(receivedAt) | E(eventId)` scanned forwards or backwards gives
both fields ascending or descending, respectively. The encoding must preserve prefix order for
IDs too (use a zero-escaped, terminated byte encoding, not a length prefix in a sorted field).
Ranges use exact inclusive/exclusive bounds or the successor of a complete prefix; never use a
sentinel that could be part of an ID. Test ties, empty/prefix IDs, non-ASCII and boundaries.

`H16(eventId) = first four bits of SHA-256(domain || E(eventId))`, written as `00`..`0f`.
Examples below use conceptual tuples; actual tuple encodings must retain the ordering above.
The event's primary item is independent of timestamp so a duplicate with a different timestamp
still hits the same conditional key.

| Item | PK | SK | Contents and use |
| --- | --- | --- | --- |
| Org, project, key, token, release, bundle, archive state, erasure | entity kind + scoped ID | `DATA` | Authoritative entity and private revision; no payload projection. |
| Unique marker | `UNIQ | kind | scope | hash(value)` | `OWNER` | Full value and owner key; distinct namespace for org slug, project slug, public key, token hash, release version, debug ID. |
| Active key marker | `ACTIVEKEY | project` | `OWNER` | Selected active key identity and project key-set revision, updated transactionally when keys change. |
| Active-key list | `ACTIVEKEYS | project` | encoded key ID | Pointer for every non-revoked key, transactionally maintained with the marker. |
| Project list | `PROJECTS` | encoded project ID | Pointer to project. |
| Key list | `KEYS | project` | encoded key ID | Pointer to key. |
| Release list | `RELEASES | project` | encoded release ID | Pointer to release. |
| Bundle list | `BUNDLES | project | release` | encoded bundle ID | Pointer to bundle. |
| Issue | `ISSUE | project | issueId` | `DATA` | Full issue and private monotonically increasing revision. |
| Global issue lookup | `ISSUEID | issueId` | encoded project ID | Pointer to issue; created with the issue. |
| Issue sort | `IL | project | (ALL or status) | sort` | `D(sortValue) | E(issueId)` | Pointer and indexed value. Six rows per issue: 3 sorts x all/status. |
| Event | `EVENT | project | eventId` | `DATA` | Full `StoredEvent`, immutable; direct uniqueness and lookup. |
| Event project time | `ET | project | H16(eventId)` | `T(receivedAt) | E(eventId)` | Event pointer. |
| Event issue time | `EIT | project | issueId | H16(eventId)` | same | Event pointer. |
| Event subject | `ES | project | kind | hash(value) | H16(eventId)` | same | Event pointer; one for each present user ID, email, username, IP. |
| Erasure list | `ER | (ALL or project) | (ALL or state)` | `E(projectId) | E(erasureId)` | Pointer; four rows per request, moved atomically on state changes. |

List rows are small pointer items and carry no event payload. The issue and list items are not
DynamoDB secondary indexes, despite the word "index" in the access-pattern descriptions below.
For event selectors store the exact normalized port value: no lowercasing, IP rewriting or
other equivalence not in the contract. Empty or absent user fields must be distinguished.

## Common operations, ordering and cost notation

All reads below use `ConsistentRead: true` on the **base table**, including `Query` and
`BatchGetItem`. `Query` paginates at DynamoDB's 1 MiB response boundary; `BatchGetItem` chunks
at 100 keys, retries `UnprocessedKeys` with bounded backoff, restores requested order and
propagates exhaustion. The strong reads are not a multi-item snapshot. No read falls back to a
scan or to an unbounded client-side filter. Opaque versioned cursors include operation, scope,
filters, direction and last emitted key, and reject malformed or mismatched values. Limits
follow the shared contract (1..10,000). Resuming uses the exclusive last *emitted* key, not a
shard's last fetched key, so prefetched but unreturned rows are not skipped. No snapshot is
promised; changes crossing a cursor can be missed or repeated.

Costs are request units for on-demand Standard, not dollars: `R(x) = ceil(x/4 KiB)` for an
existing strongly read item, at least 1 for a missing point read; `Q(x) = max(1, ceil(x/4 KiB))`
per strong Query page, plus AWS's possible sparse-partition overhead; `W(x) = ceil(x/1 KiB)`.
A transaction writes `2 * sum(W(item))`; index rows count separately. A successful transaction
with conditions is charged for the affected items; failed conditions, retries, minimums and
throttling add variable cost. `Query` cost uses bytes *evaluated*, not returned; a
`BatchGetItem` rounds per item. AWS can charge more for sparse queries. These formulas describe
successful calls only. Worst case below means successful logical operation at declared page /
item / transaction limits, **excluding retries**, concurrent churn, and arbitrarily many input
IDs; there is no finite wall-clock or total cost bound under contention. Explicitly cap retries
and return a typed error rather than return partial success as complete. DynamoDB's hard limits
are 400 KiB/item, 100 actions and 4 MiB/transaction; no two actions may address one item.

For a pointer page of `n` items sized `p`, with `q` Query calls across shard partitions, and
hydrated items sized `x_i`, read cost is `sum Q(pageBytes_j) + sum R(x_i)`, including any
lookahead. Typical `n=20`, sub-1 KiB pointers and sub-4 KiB entities: one unsharded Query
(about 5 R) + 20 R = 25 R; a 16-shard event merge can require at least 16 R even when empty,
plus evaluated pointer bytes and hydration. For a 10,000-row page, at the 400 KiB item limit,
hydration alone can reach 1,000,000 R, plus all Query pages and lookahead; a production
implementation should use bounded concurrency and an explicit memory budget. Fully enumerating
unbounded listKeys, getById or an `eventIds` selector necessarily has unbounded total cost.

## Operation-to-access-pattern map

Notation: `G(k)` = strong GetItem; `B(keys)` = strong BatchGetItem and retry; `Q(pk, range)` =
strong base-table Query with PK equality and ordered SK condition; `TX` = TransactWriteItems.
`V` is the private revision. A point read costs typically 1 R, worst 100 R at 400 KiB;
missing is at least 1 R. A two-step marker lookup costs typically 2 R, worst 200 R. `TX(n)`
of <=1 KiB actions costs 2n W, a conservative upper bound of 2 * (4096 + 99) = 8390 W per successful
transaction, allowing for per-item rounding across 100 actions as well as the 4 MiB limit. Actual costs use
the preceding formulas and sizes, including old item size for deletes/updates. Costs for each
list are the pointer-page formula above; operations that enumerate all rows have no finite
worst-case total, only a per-page bound.

| Port operation | Exact access path and behavior | Typical / worst successful cost |
| --- | --- | --- |
| `projects.getOrg`, `get`, `getTokenByHash`, `getKey`, `getOrgBySlug`, `getProjectBySlug` | `G` entity by ID, or `G` exact unique marker then `G` owner. Verify marker's value and scope; absent returns null. | 1 or 2 R / 100 or 200 R. |
| `projects.putOrg`, `put`, `putKey`, `putToken` | `G` old entity; TX condition on its revision (or absence), put entity and new owner marker, delete changed old marker; add/move project/key list row if applicable. Owner marker permits the same ID, rejects another as `ConflictError`. For `putKey`, maintain active-key list and project key-set revision as described below. Do not target the same key twice if old=new. | 1 R + 4..14 W normally, plus active-key query when replacing the selected key / 100 R + query and transaction bounds; bounded CAS retry. |
| `projects.getOrCreateActiveKey` | `G` active marker + `G` referenced key; if no selected active key, TX condition on the unchanged key-set revision, put key, public-key marker, key list and active-key list rows, and replace marker. On conflict reread winner, never publish losing key. | existing 2 R; create ~2 R + 10 W / 200 R + transaction bound, retries extra. |
| `projects.list`, `listKeys` | `Q(PROJECTS)` or `Q(KEYS | project)` by SK, then `B` owners; stable ascending ID keysets. `listKeys` drains pages. | page formula; full key list unbounded. |
| `issues.get` | `G(ISSUE | project | id)`. | 1 R / 100 R. |
| `issues.getById` | `Q(ISSUEID | issueId)` ascending project, then `B` issues; return all matching projects. | page formula; unbounded cross-project total. |
| `issues.list` | `Q(IL | project | ALL/status | sort)`, forward; lastSeen `[from,to)` translates to complemented bounds. `B` issues, verify current status/sort key, discard stale hydrated rows and continue querying until limit+1 or exhausted. Return page in indexed order. Reject text and non-lastSeen sort with a lastSeen range. | page formula; concurrent moves may require more refills without finite bound; cap and fail rather than misstate `nextCursor`. |
| `issues.update` | `G` issue; TX CAS `V`, update entity and atomically replace the changed status-specific sort rows (and any changed sort keys). Preserve all other fields. Missing throws `NotFoundError`. | 1 R + 14 W for a status move (issue plus 3 deletes + 3 puts) / 100 R + transaction bound. |
| `issues.repairAfterErasure` | `G` issue/V; `Q` all 16 EIT shards descending for latest, `B` selected event; TX CAS same V, clamp count at zero, repoint if an event remains, replace changed count-sort rows. Every event insert **and delete** advances issue V in its own transaction, fencing the query: retry the whole read/query/CAS if V changed. Keep old pointer if empty. | >=17 R + event hydration + 10 W for issue and 2 count-row replacements / page and transaction bounds; contention retries extra. |
| `events.get` | `G(EVENT | project | eventId)`. | 1 R / 100 R. |
| `events.listByIssue` | With issue ID, `Q` 16 EIT partitions; without it, `Q` 16 ET partitions. Apply `[from,to)` and exclusive `after` to each ordered SK; merge by `(receivedAt,eventId)` in requested direction, hydrate with `B`, fetch limit+1. | 16-shard page formula / page bound; more queries if 1 MiB boundaries or stale rows. |
| `events.scanOlderThan` | `Q` 16 ET partitions for `SK < T(cutoff)` ascending; merge and hydrate, cursor is last emitted `(receivedAt,eventId)` scoped to project/cutoff. | same as event list. |
| `events.deleteBatch` | Strong `B` event IDs (dedupe); for each found immutable event, TX conditional delete event and its ET, EIT and present ES rows plus CAS bump issue V; retry conflicts. Missing is a no-op. Do not use `BatchWriteItem`. | Per event 1 R + 2*(4+u) W for <=1 KiB items, `u`=0..4 subject rows / unbounded input count, per-TX bound. |
| `events.deleteBySubject` | For one selector, `Q` its 16 ES partitions through `receivedAt <= before`, merge and `B`; for eventIds, dedupe input and `B` all IDs, sort by `(receivedAt,eventId)`, retain <=before. Delete up to limit via the same per-event TX as deleteBatch, count **successful** conditional deletions by issue and collect blob keys, then probe one more surviving match for `hasMore`. Repeat from earliest on the next call. Verify selected event still matches. | Subject: 16-shard page cost + per-event delete cost; eventIds: `sum R(event)` for the input + per-event delete cost. Input list and contention have no finite bound. Crash caveat in decision 5. |
| `releases.get`, `getReleaseByVersion`, `findBundleByDebugId` | `G` entity or `G` exact version/debug marker then `G` owner; missing returns null. | 1 or 2 R / 100 or 200 R. |
| `releases.put` | `G` old release; TX conditional revision, entity, version marker, list row, delete old marker on rename; foreign owner is `ConflictError`. | ~1 R + 6..8 W / 100 R + transaction bound. |
| `releases.list`, `listBundles` | `Q(RELEASES | project)` / `Q(BUNDLES | project | release)` ascending IDs, then `B` entities. | pointer-page formula. |
| `releases.putBundle` | `G` old bundle; TX revision-guarded entity and list row, marker puts for added/retained debug IDs and deletes for removed IDs. Move list row if release changes; assert each new debug marker absent or same owner. Deduplicate actions. Enforce decision 4 before any writes. | 1 R + 2*(2 + debug marker changes) W / <=100 actions and 4 MiB. |
| `releases.deleteBundle` | `G` old bundle; if present, TX conditional on revision deletes entity, its list row and all debug markers, each owner checked; missing is a no-op. | 1 R + 2*(2 + debug IDs) W / transaction bound. |
| `meta.getArchiveState`, `getErasureRequest` | `G` scoped entity. | 1 R / 100 R. |
| `meta.compareAndSetArchiveState` | Validate project and `next.version`; conditional `PutItem`: absent and version 0 for null expected, else version equals expected and next is expected+1. Condition failure is `VersionConflictError`. | 1 W / 400 W; failed condition has read cost. |
| `meta.compareAndSetErasureRequest` | `G` old row to determine its list keys; validate project, ID, version; TX condition on old version or absence, write entity, put/delete its 4 state/project list rows as needed. Map a failed version condition to `VersionConflictError`. | 1 R + 2*(1+up to 6) W / 100 R + transaction bound. |
| `meta.listErasureRequests` | Select one of the four ER partitions based on provided project/state and `Q` ascending project/erasure ID, then `B` entities. | pointer-page formula. |
| `migrate` | No data scan or implicit schema mutation; no-op after infrastructure provisioned the table. Schema version changes need an explicit migration plan. | 0 R / 0 W. |

Every `putKey` transaction also changes the key-set revision and the active-key list as needed.
If it revokes or moves the selected key, it first queries the consistent active-key list for an
alternative, excluding the key being changed, then updates the selected marker in the same
transaction, conditional on the key-set revision read before that query. Concurrent changes
force a retry. Thus a marker with no selected key means no active keys, and
`getOrCreateActiveKey` cannot manufacture a second active key while another already exists.
New-key creation and changes to multiple projects must condition/update each affected marker
without targeting any item twice; treat project ownership changes as a reviewed edge case.

Natural-key mutations require CAS on the entity even on update, an owner condition on marker
puts/deletes, and a retry on revision conflict. This prevents two IDs claiming a slug, public
key, token hash, project release version or debug ID and prevents a rename deleting another
owner's marker. Duplicate debug IDs within one bundle are normalized once; a debug ID owned by
another bundle conflicts. Token *hashes*, never plaintext tokens, are indexed. Large bundles
and changing natural-key scopes must be validated before building a transaction.

## `recordEvent`: exactly one commit transaction

Validate matching project, issue, event ID and receivedAt in occurrence and event, all keys,
item sizes, count bounds and fingerprint. Strongly `G` issue and event if needed, then compute
an issue candidate and old/new sorted keys. A **single** `TransactWriteItems` commits:

1. Conditional `Put` of the immutable event at `(project,eventId)` with `attribute_not_exists`.
2. Conditional issue `Put` at expected V (or absence), with `V+1` (or initial V), full issue,
   and count incremented exactly once. A new issue adds its global issue-ID pointer.
3. Conditional puts of ET and EIT pointers and up to four ES pointers.
4. The difference between old and new six issue sort rows: delete old and put new, omitting
   unchanged keys and coalescing duplicates. On creation put six rows. No action targets the
   same item twice. Conditions on the issue fence concurrent status updates and deletions.

First/last seen are min/max **receivedAt**. Latest pointer is max `(receivedAt,eventId)`;
a tie advances only for the greater event ID. A resolved issue regresses only when
`resolvedAt` is absent or `receivedAt > resolvedAt`; clear resolution only then. A late event
cannot regress a more recently resolved issue. Preserve issue details according to the current
SQL implementation. Return `isNew` and `isRegression` computed from the version that actually
committed, not from an earlier failed attempt. On an event-exists condition failure, strongly
read the existing event and its issue, return `inserted:false`, `isNew:false`,
`isRegression:false`, and never touch the issue. On issue revision conflicts, reread and
recompute. Distinguish conflicts, throttling and validation errors; use bounded jittered retry.
Use a unique client request token per *identical* transaction attempt and reuse it on an
ambiguous network response within DynamoDB's token window. If an ambiguous result outlives
that window, the port cannot distinguish an earlier successful call from a pre-existing event;
treat it as duplicate and document the notification ambiguity.

Worst normal new issue: 1 event + 1 issue + 1 global pointer + 2 time pointers + 4 subject
pointers + 6 issue sort rows = **15 actions**. Existing issue worst case, all three sort values
and status change: 1 event + 1 issue + 2 time + 4 subject + 12 old/new sort actions =
**20 actions**. All items together must be <=4 MiB; each <=400 KiB. With 2 KiB event,
1 KiB issue and <=1 KiB pointers, an ordinary existing-issue event changing lastSeen and count
but not status or firstSeen has 16 actions and costs 34 W, plus the strong issue read; the
20-action worst for those sizes costs 42 W. Transaction conflicts and failed conditions cost
extra. The serialized issue item is a contention point even with sharded event keys. A single
hot fingerprint will be bounded by conditional transaction conflicts and its physical
partition; sharded counters would violate the one-transaction/current-count design and need a
new, reviewed consistency contract.

## Shards, erasure and retention

Every event writes one primary item, two time pointer items and 0..4 subject pointer items;
only the issue and its changing issue-list rows are shared with other events of that issue.
An event/project/issue/subject time lookup queries all 16 shard PKs, ordinarily in bounded
parallel, merges their next keys and hydrates only selected candidates. No day directory or
bucket crossing cursor is needed: an event with an arbitrarily old receivedAt remains in its
shard's ordered stream. At most 16 initial Query calls per page, plus 1 MiB paging/refills and
BatchGetItem calls. There is no guarantee that 16 logical keys map to 16 physical partitions.
AWS documents approximately 1,000 write units/s and 3,000 strong read units/s **per physical
partition**, not a universal 1,000 events/s per project; transaction double charging, item
size, other keys and uneven distribution reduce realized rates.

Explicit deletion removes all event lookup items in the same transaction as the event; deletion
also atomically increments the issue revision with `ADD` to fence repair, without changing
issue count or requiring an extra issue read. This keeps the
existing archive workflow's issue counts unchanged and lets erasure explicitly repair them.
No event or pointer carries a TTL under this strategy, including if `StoredEvent.expiresAt` is
present. The shared module's TTL attribute named `expiresAt` must **not** receive a numeric
event expiry; store the port's value inside the serialized domain item instead. The KV table
continues to use its own numeric TTL. Deleting by selector needs no GSI and no Scan. PITR and
backups may retain deleted PII for their configured retention, up to 35 days for PITR; physical
erasure must include the backup policy and the M4 receipt/recovery decision above.

## Infrastructure, capabilities and emulator

- `infra/modules/aws/dynamodb`: for `purpose=store`, retain string PK/SK, on-demand billing,
  PITR, encryption, protection and the shared TTL declaration, but remove all eight dynamic
  GSI attribute definitions and all eight GSIs. `purpose=kv` stays PK/SK only. Update module
  README, mock-provider key/projection tests, emulator table creation/probes and snapshots.
  There are no projections to configure. Compared with the current eight `ALL` GSIs this
  prevents event payload copies; pointer items require extra strongly consistent base reads.
  The private revision and pointer rows are ordinary attributes, not Terraform schema.
- `store-dynamodb` descriptor output names, bindings and capability flags stay unchanged:
  `textSearch:false`, `lastSeenRangeOnOtherSort:false`, `deleteStrategy:explicit`.
  Reject unsupported queries with `UnsupportedQueryError`; never approximate them with a
  filtered full project read. No other port operation is intentionally unsupported, except
  the explicit debug-ID bound and item/key-size limits highlighted above.
- IAM policy outputs remain separate. **read**: `GetItem`, `BatchGetItem`, `Query` on table;
  no index ARN is needed once store has no GSIs. **write**: `PutItem`, `UpdateItem`,
  `DeleteItem` on table, because index and natural-key maintenance transactionally deletes
  old rows, and `GetItem` / `Query` / `BatchGetItem` as needed by the read-modify-write paths.
  **delete**: `DeleteItem`, `UpdateItem`, `GetItem`, `BatchGetItem`, `Query` for explicit
  event deletion / repair; exact capability unions must be verified against every role in
  core requirements. The write grant necessarily includes `DeleteItem` for old lookup rows:
  an unrestricted table grant would also allow consumer/API functions to delete event items.
  Review whether `dynamodb:LeadingKeys` conditions can safely restrict that action to the
  exact mutable lookup PK namespaces in transactions, and test with the IAM simulator on real
  AWS. If not, record the least-privilege regression explicitly before shipping; separating
  index and event tables would conflict with the current single-table model. DynamoDB
  authorizes a transaction by the underlying item actions;
  add `ConditionCheckItem` only if an actual separate `ConditionCheck` action is used, and
  do not grant `Scan` or `BatchWriteItem`. Changing policy outputs affects mock assertions,
  generated-root least-privilege tests and the deployed role matrix; do not widen blindly.
- Winterbaume at `69fed1d7fb0eb9a2738ff3274197c7591129c4cb` can exercise ordinary API
  shapes, query order, pagination, item conditions, transactions in basic cases and contract
  behavior; probe transaction cancellation reasons, 1 MiB boundaries and transaction atomicity
  explicitly before relying on them. Its conditional UpdateItem check and write are not atomic
  under concurrent requests (see `WINTERBAUME_GAPS.md`); this does not prove CAS, concurrent
  counters, uniqueness, fencing or all-or-nothing transaction semantics on AWS. Test those on
  real DynamoDB in M3h or add DynamoDB Local when a named probe demonstrates a missing feature.
  Upstream main reportedly honors index projections; pin only an immutable verified revision,
  re-run gap probes and document which gaps close. Projection tests remain relevant to any
  future GSI, though this design requires none.

## Illustrative monthly cost

Assume 1 million events/day, evenly spread over 50 projects, 30 days' active retention,
30-day steady state, on-demand Standard in a region priced like AWS's published example:
$0.625/million write units and $0.125/million read units. Actual regional rates and storage,
PITR, retries, cross-service and free-tier charges vary. Assume each event item is 2 KiB,
each pointer 0.5 KiB, issue <=1 KiB, all four subject fields present, and every event updates
lastSeen and count without changing status or firstSeen. The resulting per-event write is 34 W
as above: 30 million * 34 = **1.02 billion W**, or **$637.50** for ingestion writes. Explicit
retention deletion is one event plus six event pointers plus one issue revision update:
2*(2+6+1) = **18 W** per event, about **540 million W / $337.50** monthly once steady state is
reached. Together that is **1.56 billion W / $975** before issue creates, conflicts and other
writes. Strong issue pre-read alone adds about 30 million R / **$3.75**; delete pre-read adds
another 30 million R / **$3.75**, before archive queries, list hydration or retries. At one
16-shard archival query per project per day, the empty-query minimum alone is 24,000 R/month;
actual pointer and event reads dominate. Rough event+pointer live data is 30 million *
(2 KiB + 6 * 0.5 KiB) = 150 million KiB = **143.1 GiB**, excluding item/index overhead,
issues, markers, PITR and transient lag; 30-day average while starting empty is about half.
This is an estimate, not a quote. If only one subject field is normally populated, both write
and storage costs are materially lower. A realistic workload measurement must include payload
size distributions, event deletes, issue hotness, query page sizes and retry costs.

References: [transaction API limits](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html),
[transaction billing and conflicts](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html),
[partition throughput](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/data-modeling-blocks.html),
[query capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Query.Other.html),
[GSI consistency and projections](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html), and
[AWS pricing example](https://aws.amazon.com/dynamodb/pricing/).
