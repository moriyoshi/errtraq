# DynamoDB active-store design (M3e step 1b, review draft)

This is a proposed revision, not implemented behavior. The owner selected sparse GSIs,
both per-event and batched ingestion, configurable hot-issue rejection, and asynchronous
subject indexing. This draft proposes changes to the current port and ARCHITECTURE.md; their
current wording remains authoritative until this design is reviewed and the corresponding
contracts and architecture are changed. [SUBJECT_INDEX_DESIGN.md](./SUBJECT_INDEX_DESIGN.md)
is part of this design and contains the consolidated proposed interfaces, rate policy,
completion barriers and adapter contract changes. No `Scan` is an access path.

## Review decisions and non-negotiable limitations

- **Sparse, eventual GSIs:** no transactional event/issue-list pointer rows. Every GSI result
  is a candidate, re-read strongly from the base table and checked for current membership,
  filters and sort position. Hydration removes stale positives but cannot discover a missing
  index entry or make an eventual GSI strongly consistent. Lists can omit recent writes,
  return short pages, and move records across cursors. APIs must say so explicitly; a lag is
  not bounded by AWS's eventual-consistency contract.
- **R6 cannot safely mean "the issue GSI count is authoritative" by itself.** A GSI query
  can miss a committed event indefinitely, and archived events have left the active store
  while issue count historically includes them. A correct repair needs the independent durable
  admission/index barrier and active-ID control total in the companion document, plus a
  separately maintained archived baseline. Until those prerequisites are available, repair
  remains pending and cannot claim exact success. This qualifies, rather than silently
  implements, the suggested issue-GSI count query. A pure GSI count is only a candidate.
- `ADD` avoids comparing count/revision on ordinary inserts; branch conditions are still needed
  for first/last/latest and regression. A bounded retry budget protects the invocation; it
  cannot guarantee all 500 simultaneous writes succeed. Throttle exhausted conflicts and
  let the queue redeliver, never report an inserted event as successful without its issue bump.
- Base event identity is `project + eventId`, distributed by distinct base partition keys,
  not 16 fixed base shards or event pointer rows. Only the project-time GSI has fixed shards.
  A single hot issue and hot issue-sort GSI partition remain physical bottlenecks.
- Exact notification semantics after an ambiguous commit, atomic admission barriers across
  ports, destructive repair during ongoing writes, and debug-marker takeover require the
  additional interfaces below. These are approval items, not solved by eventual reads.

## Encoding, base items, indexes

All base PK/SK values are typed strings. Components are collision-free length-framed or
escaped, with a separate order-preserving terminated UTF-8 byte encoding for sort components.
Keys are validated against DynamoDB's 2048-byte PK / 1024-byte SK and 400 KiB item limits
before writing. Timestamps are canonical four-digit-year UTC milliseconds; string lexicographic
order is chronological. Count is a non-negative safe integer stored as `N` (reject overflow).
Use descending count and an **order-reversed, prefix-safe byte encoding of issueId** as a
second range component: descending scan then produces count descending, issue ID ascending.
A single native `(count, issueId)` descending scan would reverse *both* components and violate
the tie rule. For equal-count paging query the equality-count / tie range first, then the
strictly smaller count range, merging pages without skipping; multi-key Query inequalities
must be the final key condition. Event time pagination likewise needs an equality-time /
exclusive event-ID query for a tie, followed by the strict earlier/later time range; apply
half-open [from,to) bounds and direction to both without relying on a tuple inequality that
DynamoDB cannot express. Date-sort issue lists can instead use an encoded composite
`descending timestamp | ascending issueId` in a single string scanned forward. Validate all
bounds, IDs and cursor encodings with ties, prefixes, non-ASCII and minimum/maximum time.

The provider minimum is **6.32.1**. Its [source](https://github.com/hashicorp/terraform-provider-aws/blob/v6.32.1/internal/service/dynamodb/table.go)
implements GSI `key_schema` as a list; a local `terraform init` from the existing plugin cache
and `terraform validate` succeeded on a keys-only GSI with one HASH and two RANGE entries,
one numeric. AWS documents [multi-attribute GSI keys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html).
This validates provider schema only, not real create/query behavior, GSI ordering, or
Winterbaume support. Test both pinned providers and actual AWS before relying on it.

| Base item | PK / SK (conceptual) | Notes |
| --- | --- | --- |
| Event | `EV | project | eventId` / `DATA` | One immutable event, idempotency key ignores receivedAt. GSI1 and GSI2 attributes; minimal subject-builder references, no raw PII in index keys. |
| Issue | `IS | project | issueId` / `DATA` | Mutable fields are top-level DynamoDB attributes, not an opaque JSON blob: count `N`, first/last/latest, status, resolution, optional countSort and dirty generation. Assemble the `Issue` from those attributes on read. GSI3..6 attributes. |
| Org, project, token, release, bundle, metadata | `type | scope | id` / `DATA` | Natural-key markers and a private entity version where needed. |
| Project key | `KEY | publicKey` / `DATA` | Hot ingest `getKey` is one strong GetItem. A separate project/key-ID unique marker plus project listing index supports mutable put/list and detects conflict. Key rotation/public-key changes are transactional. |
| Natural-key marker | `UNIQ | kind | scope | hash(value)` / `OWNER` | Exact normalized value and owner; strong reads/conditional ownership. Slug, project slug, token hash, release version, key identity and public-key rename. Hash is not encryption. |
| Active-key guard | `ACTIVE | project` / `DATA` | Serializes get-or-create/revocation and identifies current active key; atomic owner checks. |
| Debug marker | `DEBUG | project | debugId` / `OWNER` | Owner bundle ID and generation; staged in background chunks; no raw user data. |
| Subject entry and admission work | See companion document | Durable asynchronous indexing records, never written as pointers inside `recordEvent`'s transaction. |

Each GSI below is `KEYS_ONLY` unless stated, so no event payload is copied. DynamoDB always
projects the base primary key and GSI key attributes. Results require strong `BatchGetItem`
chunks of <=100 keys, retrying unprocessed keys; validate current values and suppress stale
entries. A batch get is not a snapshot. `INCLUDE` is optional only after measurement; D1 still
requires a strong read of each base item. Scope and event type prefixes make indexes sparse.

| GSI | Partition key | Sort key / entries | Purpose and write pressure |
| --- | --- | --- | --- |
| 1 `event-project-time` | `project | H16(eventId)` | `(receivedAt, eventId)` | Project events and archival; 16 queries per page, merge ordered streams. GSI sharding is stable for the table's lifetime. |
| 2 `event-issue-time` | `project | issueId` | `(receivedAt, eventId)` | Single issue events and candidate repair count/latest; no fan-out, but one very hot issue remains a hot partition. |
| 3 `issue-id` | `issueId` | `projectId` | Cross-project issue lookup. |
| 4 `issue-last` | `project | status` | encoded lastSeen desc / ID asc | Issue list with optional lastSeen range. |
| 5 `issue-first` | `project | status` | encoded firstSeen desc / ID asc | First-seen list. |
| 6 `issue-count` | `project | status` | numeric `countSort`, inverted ID | Approximate count list; refresh below. |
| 7 `entity-list` | `kind | scope` | entity ID | Sparse projects, keys, releases, bundles and other enumerations. Strong direct reads and natural markers remain base-table. |
| 8 `erasure-list` | `ALL or project | ALL or state` | encoded project / ID | One item cannot carry four keys for one GSI. Use four sparse **metadata list items**, written atomically with the erasure state, or use four distinct GSI attributes/indexes on the erasure item; recommend four GSIs to honor D1's no pointer rows. See below. |
| 12 `dirty-count` | `refresh | H16(issueId)` | `(refreshDue, issueId)` | Sparse issue attributes flag count-sort work. A background reconciler polls all shards; a queue is only a wake-up hint. |

For GSI8, choose **four sparse indexes** `erasure-all`, `erasure-project`, `erasure-state`,
`erasure-project-state`, each with its own PK and the same sort key. They apply only to the
small metadata item, not events. Together with the dirty-count index, total is **12 GSIs**,
under the default table limit 20; confirm quota and lifecycle on replacement. No per-event subject GSI: asynchronous inverted
index entries and its own query layout are defined separately. The conceptual GSI7 must be
implemented with distinct type/scope keys and a globally scoped project listing; project keys
must be unique across scopes. Bundle list keys include project+release. `KEYS_ONLY` GSI
entries do not provide index values for non-key filters, so hydrate before evaluating.

Status-less issue lists merge exactly the three status partitions. Read issue GSI entries,
hydrate and verify current status, indexed sort value and project, keep the last **emitted**
composite key in a scoped opaque cursor, and refill when stale candidates are discarded. The
`from` bound is inclusive and `to` exclusive. A status change or delayed propagation can
cause a row to be skipped or repeated; non-snapshot cursors cannot repair that. For
`countSort`, display the true count separately and expose that ordering is approximate.
Unsupported text and lastSeen-range-on-other-sort queries throw `UnsupportedQueryError`.

## Event writes, batching and count-sort refresh

`recordEvent` delegates to `recordEvents` with one event. In `per-event` mode each transaction
has exactly two actions: conditional `Put` event (attribute absent), and `Update` issue with
`ADD count :one` plus the branch-specific `SET`/`REMOVE` fields. No issue revision equality
check or transactionally maintained pointer item is added. A strong pre-read chooses one of:

1. **Absent issue:** update conditioned absent, initialize identity, fingerprint, issue
   details, unresolved status, first/last/latest and count via `if_not_exists` / `ADD`.
2. **Existing, newer:** require same fingerprint and guarded last/latest tuple; advance latest
   only for larger `(receivedAt,eventId)`. A late event cannot overwrite a newer pointer.
3. **Out of order:** require the branch's tuple comparison, leave last/latest unchanged; set
   firstSeen only under a separate guarded minimum branch when the incoming time is earlier.
4. **Regression:** require current status resolved and unchanged resolvedAt (or absence), and
   incoming receivedAt strictly greater than resolvedAt; set unresolved and remove resolvedAt.
   Otherwise preserve status. Issue `update` and repair must cooperate with those same
   conditions/fences, so no event overwrites a concurrent resolve or erasure repair.

DynamoDB update expressions do **not** have a general conditional `SET` expression: choose a
branch and put its predicate in the transaction condition. Compose branches for simultaneous
firstSeen/latest/status changes. If a condition fails, inspect ordered cancellation reasons
and `ReturnValuesOnConditionCheckFailure: ALL_OLD` to recompute the branch without an extra
read *when the service returns the item*; if unavailable, strong GetItem. An event-exists
failure returns a duplicate and never applies `ADD`; read the saved event's actual issue.
Retry conditional races, conflicts and throttling with bounded jitter; fail retryably after
budget exhaustion. Strong-read preimages classify `isNew`/`isRegression` only if the branch
condition actually commits. A successful `TransactWriteItems` has no returned issue image:
strongly read the issue after commit and document that concurrent later updates may be visible.
Use a stable idempotency token per identical request, never reuse with changed conditions;
ambiguous response beyond the token window cannot determine whether this delivery or an older
one inserted the event. Preserve the duplicate check and mark notification certainty as an
open contract issue.

In `batched` mode group a delivery's occurrences by `(project, issue, fingerprint)`, retain
the input order for per-event flags and split to <=99 event puts + one issue update, <=4 MiB
aggregate and <=400 KiB per item. Distinct event IDs only per transaction; duplicate input
IDs get one candidate, then duplicate results in input order. Strong pre-read known IDs in
`BatchGetItem`, filter already-present events, then conditional event puts and one guarded
issue `ADD count :N`. Derive first/last/latest and any regression by applying the same rules
in deterministic input order to only newly inserted members. A duplicate race makes the whole
transaction fail: inspect cancellation reasons, reread failed/ambiguous IDs, remove committed
duplicates and retry the remaining set; split on repeated conflicts and honor the retry budget.
A branch may fail on an independently changed issue; refresh the branch without count CAS.
The issue's `isNew` belongs to the first inserted member if the issue was absent; the first
member whose receivedAt crosses a still-resolved resolution owns `isRegression`. Return one
result for every input, with duplicate flags false. Different issue groups / chunks are not
one atomic batch: on an error return/throw a retryable per-item outcome for uncommitted work;
retry after crash is safe by event ID. Chunks must be serial for a single issue. Discuss the
new response shape and ambiguous notification behavior before implementing.

For count ordering, keep exact `count` on the issue. Maintain indexed `countSort = count` for
counts <=100; above that update `countSort` at most once per 10 seconds and schedule an
idempotent trailing refresh. A refresh uses a guarded `SET` of a freshly read count and only
clears dirty state if no later count changes were missed; retry until caught up. When countSort
becomes dirty, the issue update atomically sets a sparse dirty-count GSI key
and due time on the issue itself; a queue message is a latency hint and the reconciler queries
all 16 dirty-index shards. A refresh conditionally copies a strongly read count and clears the
dirty key only if that count is still current; otherwise it retains the flag and retries.
Eventual propagation can delay or temporarily hide this work and rekeying adds WCU. It does
not provide a hard deadline. A timer in the writer is not a guarantee. A 10-second target is
an SLO, **not an enforceable maximum** during outage,
GSI lag or retry failures. Even small counts can be temporarily stale due to GSI propagation.
The number of lastSeen GSI writes is not reduced by count coalescing. Counter exactness and
rate of count-index writes must be measured under concurrent events. See companion document
for portable rate rejection; default rejection is disabled, so users opt into data loss.

## Operation-to-access-pattern map

Notation: `G` strong GetItem, `B` strong BatchGetItem, `Qn` eventual Query GSI n followed by
strong B and validation, `TX` TransactWriteItems, `BW` BatchWriteItem with retry of unprocessed
items. Every list validates cursor scope / shape and limit, handles 1 MiB Query boundaries,
retries unprocessed B/BW keys, and fails on exhausted retries instead of claiming completeness.
No client-side full-project filtering or Scan. Costs: strong read `ceil(itemBytes/4 KiB)` R,
eventual GSI query `0.5 * ceil(evaluatedBytes/4 KiB)` R per page (plus service minimum),
transaction writes `2 * ceil(itemBytes/1 KiB)` W per action, ordinary writes/deletes
`ceil(itemBytes/1 KiB)` W; GSI writes are separate, rounded per index entry. Updates that
change an index key delete the old and write the new entry. Failed conditions, empty queries,
retries, large items, stale candidates and pagination add cost. A list has no fixed total worst
case under unbounded churn, stale entries or input size; 100-action / 4 MiB transaction and
400 KiB/item limits still apply. The formulas, not a fictitious universal bound, apply.

| Operation | Exact planned access path | Typical / upper-bound cost |
| --- | --- | --- |
| `getOrg`, project `get` | G entity. | 1 R / 100 R per 400 KiB item. |
| `getOrgBySlug`, `getProjectBySlug`, `getTokenByHash`, `getReleaseByVersion` | G unique marker then G entity; verify owner/value. | 2 R / 200 R. |
| `getKey(publicKey)` | G directly at public-key primary key; verify key not replaced. | 1 R / 100 R. |
| `putOrg`, project `put`, `putToken`, release `put`, `putKey` | G old data; TX entity and uniqueness markers, remove old marker if renamed; project/key/release gets sparse list GSI fields. Condition owner is absent or self; foreign owner is ConflictError. Updating a public key moves its primary item and marker atomically. | ~1 R + 4..8 W + affected GSI writes / TX 100 actions, 4 MiB, retries extra. |
| `getOrCreateActiveKey` | G active guard and key; TX guard + new direct key and ownership marker under conditions; on conflict reread winner. Key revocations and other active-key writes must update/fence guard. | ~2 R + 6 W / transaction bound. |
| `projects.list`, `listKeys`, `releases.list`, `listBundles` | Q7 scoped entity list, then B; keyset ascending ID, validate type/scope. `listKeys` drains. | one or more eventual index pages + n strong item reads; unbounded across all rows. |
| `issues.get` | G issue. | 1 R / 100 R. |
| `issues.getById` | Q3(issueId), B issues, validate ID; all pages. | index pages + one strong read per candidate; eventual, unbounded. |
| `issues.list` | Q4/5/6 on one status or merge 3; B, verify indexed key and filters. Count-sort uses refreshed countSort, not exact count. | 1 or 3 minimum index queries + B per candidate; no finite bound with churn. |
| `issues.update` | G issue; conditional UpdateItem status/resolvedAt, retry branch changes; update GSI partition attrs on status change. | ~1 R + 1 W + old/new issue-list GSI entries / item size and retries. |
| `repairAfterErasure` | Under issue write fence and archive lease, Q2 count/latest + B and dedupe; compare candidates to the **strong, complete** indexed-ledger active-ID control total; add archived baseline and account for archive erasures. If not equal, wait/retry; never infer completeness from an empty GSI. Conditional issue update against fenced mutation generation; preserve last pointer if no active event. | Q2 all issue entries + B each + ledger check + conditional W; unbounded wait/cost under GSI lag. |
| `events.get` | G exact project+eventId. | 1 R / 100 R. |
| `listByIssue` | Q2 for specified issue, or 16-way Q1 for no issue; time range and after keyset, merge ordered candidates then B and validate. | 1 or 16 minimum index queries + B per candidate; eventual and unbounded refill. |
| `scanOlderThan` | Q1 16 shards, ascending and cutoff exclusive; merge, B, validate; last-emitted cursor. | 16 minimum index queries + B; cannot prove empty while GSI lags. |
| `deleteBatch` | BW exact event keys in groups <=25, retry `UnprocessedItems`; remove associated subject entries via the independently durable idempotent background deletion task. Archives must not advance a completeness watermark from one empty eventual query. | Per <=2 KiB event ~2 W base + 1 W per removed event GSI; unbounded IDs/retries. |
| `deleteBySubject` | Replace by background-index cursor lookup plus explicit event-ID deletion and durable receipt/recompute protocol; see companion. | Sharded subject queries + B + deletions; cannot treat a lagging empty index as complete. |
| `releases.putBundle`, `deleteBundle`, `findBundleByDebugId` | Pending-generation marker protocol below; G debug marker + G bundle, active-generation check. Bundle enumeration via Q7. | O(debug IDs) ordinary/conditional writes and reads, chunked; no 48-ID limit. |
| `meta.getArchiveState`, `getErasureRequest` | G scoped metadata. | 1 R / 100 R. |
| `meta.compareAndSetArchiveState` | Conditional Put/Update with version 0 on absent or exact expected+1, else `VersionConflictError`. | 1 W / 400 W plus failures. |
| `meta.compareAndSetErasureRequest` | Conditional Put/Update of metadata with four sparse GSI attributes; no list pointers; validate project, ID, version. | 1 W + up to 4 new/changed index entries / item size and failures. |
| `meta.listErasureRequests` | Query exactly one of four erasure GSIs for project/state combination; B then verify. | index pages + one strong read per candidate, eventual. |
| `recordEvent`, `recordEvents` | Two-action or N+1 TX as above, event condition, issue atomic ADD. | Per-event example below; transaction limits and bounded retries. |
| `migrate` | No automatic data scan; infra owns schema and versioned backfills. | 0 data R/W. |

## Bundles, TTL and erasure

Bundles have an immutable ID and generation with state `pending`, `active`, or `abandoned`.
Create a pending generation with expected debug-ID count and digest; reserve each debug ID with
a conditional owner+generation marker in idempotent chunks. Collisions with another **active**
owner are conflicts; a pending owner is a retryable reservation, not silently stolen. Verify
all expected markers via strong reads/checkpointed manifest, then atomically transition the
same generation to active with a guard; `findBundleByDebugId` returns only an active owner
whose generation matches. On replacement, keep the previous generation active until the new
one is fully prepared; generation-specific markers and a single active-generation switch are
needed. A conflict with the *same* bundle's previous generation must not destroy its visibility.
Delete marks the active generation unavailable first and removes markers in resumable chunks.
GC fences abandoned generations against later activation, then deletes only still-owned markers.
Use a TTL backstop **only after** fencing a pending generation as abandoned: a marker whose TTL
is set while it can become active can be asynchronously deleted after activation. Active
markers never expire. A durable blob manifest or equivalent is needed for thousands of IDs so
one bundle item stays below 400 KiB. There is no silent 48-ID limit. Atomic replacement,
concurrent delete / reservation, duplicate IDs, crash after each chunk and GC races are required
contract tests. This lifecycle is a proposed cross-adapter domain/port change.

Explicit event deletion stays primary. With no archival, a numeric TTL backstop can be
retention + configured margin; TTL is asynchronous and not precise. With archival enabled,
**do not set an event TTL that can expire before its archive batch is durably committed**:
set/enable it only after commit, or leave it absent. A fixed retention+margin cannot guarantee
the architecture's no-delete-before-archive invariant during an unbounded outage. Pending
markers use the fenced TTL rule above; KV retains its independent TTL. The subject index,
suppression, fencing and crashed-worker blob cleanup protocol are in the companion design.
PITR may preserve erased bytes for up to the configured 35 days and is not undone by item delete.

## HCL, descriptor, IAM and emulator

Replace the existing eight store GSIs with the 12 explicit sparse schemas above, keyed
attribute definitions (including `N` for countSort), `KEYS_ONLY` projections and descriptive
names. Add/adjust module tests, mocked output-shape and generated-root expectations, emulator
table derivation and both provider-version tests. The KV purpose stays without these GSIs.
Add configuration for `per-event | batched`, batch limits, count refresh, 16 fixed time-index
shards and rate/reducer configuration at the appropriate portable core level; reject unsupported
configurations and missing subject index / secret / worker capabilities in stack validation.
The table output keys can remain unchanged, but new worker resources, ports and permissions
must be represented by the infra model before generation.

Read policy needs `GetItem`, `BatchGetItem`, `Query` for table and the relevant index ARNs.
Write policy needs `PutItem`, `UpdateItem`, `GetItem`, `BatchGetItem` and `Query` as required
by admission and branch reads; `TransactWriteItems` is authorized by its underlying actions.
Do not grant `DeleteItem` to the ordinary event-write role. Natural-key rename, bundle GC and
subject maintenance **do** require conditional `DeleteItem`, and event deletion requires
`BatchWriteItem`; place these in distinct capabilities/roles and check actual grants for API,
consumer and cron rather than smuggling them into the event-write policy. This can require a
core requirements change because current generic `store.write` also covers metadata renames.
No `Scan`; consider table vs index resource scopes and the subject-index backend separately.

Pinned Winterbaume can exercise request shapes and ordinary GSI calls, but its conditional
check/update is not atomic and cannot establish concurrent branch, CAS, transaction or fence
correctness. Its pinned GSI-projection behavior is insufficient for this design; upstream main
honors projections. Bump to a specific immutable revision only after verifying its checksum,
projection semantics, old gap probes, and multi-key behavior, and update gap expectations.
Use DynamoDB Local if a named missing emulator feature blocks a required contract, while real
AWS remains necessary for production claims. See [WINTERBAUME_GAPS.md](./WINTERBAUME_GAPS.md).

M3h real-DynamoDB checklist: (1) 500 same-issue concurrent events, both modes, including
p99, throttles, retries, correctness and failure rate; (2) measure transaction base and GSI
write units, including an unchanged sparse key and key replacement; (3) force GSI throttling
and observe base-write backpressure; (4) IAM simulator and actual least-privilege checks for
each read, write, delete, subject builder, refresh and GC action; (5) multi-attribute numeric
GSI query/tie behavior and lag; (6) crash/replay barrier, TTL and erasure behavior. No finite
observed GSI lag is a correctness guarantee.

## Illustrative cost (30 days)

Assume 1 million events/day across 50 projects, 30-day steady state, 2 KiB event, 1 KiB issue,
<=1 KiB index entries, four user identifiers, and every event advances lastSeen. Use AWS's
published example prices of $0.625/million W and $0.125/million R; storage/PITR vary by region
and billing class. Exclude retries, metadata, subject index, queue, Lambda, blobs, archive,
refresh jobs, dirty-count GSI writes and reads until explicitly added below. GSI charges are
regular writes, not doubled transaction units; measure this assumption in M3h.

- Per event: event TX 4 W + issue TX 2 W + two new event GSI entries 2 W + lastSeen index
  replacement 2 W + count index replacement 2 W = **12 W** while countSort refreshes every
  event. 30 million events = **360 million W / $225**. First-seen and issue-ID keys unchanged.
- Batch 10: event TX 40 W + issue TX 2 W + 20 event GSI W + 2 lastSeen GSI W + 2 count GSI W
  = **66 W / 10 events**, or **198 million W / $123.75**. This assumes full batches for one
  issue and every batch advances lastSeen; actual batching efficiency varies. Once count-sort
  refresh coalesces, subtract up to 2 W per refresh avoided and add durable refresh-work cost.
- After steady-state retention, deleting 30 million 2 KiB events with BW costs 2 base W plus
  two 1 W GSI deletions = **120 million W / $75**. Explicit subject-index deletion and
  eventual sweeps cost extra. Active-store strong issue pre-read alone is ~30 million R /
  $3.75 in per-event mode; batch pre-reads and strongly hydrated list queries vary. The
  subject admission ledger and four-field inverted index can be material and must be measured;
  omitting them is **not** a total-system estimate.
- Rough event base storage 30 million * 2 KiB = **57.2 GiB**, plus two <=1 KiB GSI entries
  each (at 0.25 KiB estimated, **14.3 GiB**) = **71.5 GiB**, before DynamoDB storage overhead,
  issues, index work, backups and lag. At an illustrative $0.25/GB-month and $0.20/GB-month
  PITR on 76.8 GB decimal, about **$19.20 storage + $15.36 PITR**; verify region, byte billing,
  free tier and PITR backup size. 30-day average on a new empty table is about half. With
  assumptions above, the partial monthly sum is about **$338.31 per-event** ($225+$75+$3.75+
  $19.20+$15.36), not including the listed workloads or traffic.

A managed Postgres instance can be cheaper or comparable for this volume, depending on
instance size, Multi-AZ, storage, backups, connection pooling and operations. No apples-to-apples
benchmark or region-specific quote has been made; pricing an instance as free or pretending
DynamoDB wins on cost would be misleading. DynamoDB's advantage here is no managed instance or
VPC/database network setup and on-demand scaling, with the hot-key and index trade-offs above.
Sources: [DynamoDB on-demand pricing](https://aws.amazon.com/dynamodb/pricing/),
[transaction capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html),
[GSI costs and consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html).
