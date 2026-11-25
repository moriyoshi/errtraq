# M4 plan: archive tier, federation and end-user erasure

Written 2026-11-25 from ARCHITECTURE.md, the three M4 spike reports, `SUBJECT_INDEX_DESIGN.md`, TODO.md and the code at
that date. This is a plan, not a design change: where it recommends something that differs from ARCHITECTURE.md the
difference is called out as an owner decision (section 3). ARCHITECTURE.md is canonical until the owner rules.

## 1. Status

### 1.1 What already exists in code

| Area | State | Where |
|---|---|---|
| `ArchiveStore` port | Full shape: `append`, `hasBatch`, `query`, `getEvent`, `deleteWhere`, `hardErase`, `expireSnapshots`, `capabilities.rowDelete`. `deleteWhere` still takes the plaintext `SubjectSelector`. | `packages/core/src/ports.ts` (ArchiveStore) |
| `MetaRepo` | `ArchiveState` (version, `archivedThrough`, `seq`, optional `scanCursor`, `batch{committing,committed}`, `lease`) and `ErasureRequest` (five states, `maskSnapshotId`, `rewriteSnapshotId`, `filesBlobKey`, `done` carries `selectorHash`) with CAS on `version`. Implemented and contract-tested on memory, SQL and DynamoDB. | `ports.ts` (MetaRepo), `domain.ts` (ArchiveState, ErasureRequest), `testing/src/contracts.ts` (~line 560 to 720), `store-dynamodb/src/meta.ts` |
| `EventRepo` archival hooks | `scanOlderThan` (ascending `(receivedAt, eventId)`, cutoff exclusive, cursor, limit) and `deleteBatch` are implemented in memory, SQL (`store-sql/src/store.ts`) and DynamoDB (`store-dynamodb/src/events.ts`, 25 per batch write). `capabilities.deleteStrategy` is `explicit` everywhere. `deleteBySubject` and `IssueRepo.repairAfterErasure` always throw; the capability type is the literal `deleteBySubject: false`. | `ports.ts`, adapters above |
| Retention sweep | `deleteExpiredEvents` (scan, `deleteBatch`, then overflow blob delete, event first). Has a `TODO(M4)` for the archive-selected case. Not wired to any cron job. | `packages/core/src/retention.ts` |
| Cron table | `archive-planner` (hourly), `retention` (hourly :15), `erasure-worker` (every 5 min) exist in `CRON_JOBS` but their handlers only log "not implemented" (`TODO(M4)` at `stack-model.ts:55`; `cron.ts` has real handlers only for `staged-recovery` and `bundle-cleanup`). The `archive.project` topic exists and is routed to the `consumer` role (`TOPIC_ROUTES`). | `core/src/stack-model.ts`, `cron.ts`, `stack-requirements.ts` |
| Requirement rows | M4-tagged rows (`feature: "archive"`) for consumer and cron (store r/w/delete, blob staging r/w/delete/list, blob primary r/delete, archive r/w/delete), api (archive read) and KV rows. A stack with `archive` selected is validated against them. | `stack-requirements.ts` ~lines 169 to 235 |
| Stack schema | Manifest kinds `archive`, `catalog`, `engine` exist, with `childKinds`; capability schema has `archive.rowDelete`. | `stack-schema.ts` |
| TTL backstop | `eventBackstopEpoch()` computes DynamoDB TTL seconds; not wired into writes. | `store-dynamodb/src/ttl-backstop.ts` |
| Archive contract suite | `archiveStoreContract` exists (append idempotency incl. concurrent append, `hasBatch`, keyset paging both orders, issue and half-open range filters, project isolation, `getEvent` with hint, `deleteWhere` by email and by event ids, `hardErase`, `expireSnapshots`). Runs only against the fake. | `testing/src/contracts.ts` (archiveStoreContract), `contracts.test.ts` |
| Archive fake | `MemoryArchiveStore` (stages JSON arrays, not Parquet). | `testing/src/memory-other.ts` |
| Federation | `EventQueryService` (M4c) and the shared `federationSuite`; the API takes an optional `archive`. No platform passes one yet (M4g). | `core/src/event-query.ts`, `testing/src/federation.ts`, `http/src/api.ts` |
| Adapter package and infra | None. No `packages/adapters/archive-iceberg`, no `docker/` directory (ARCHITECTURE lists one), no Lakekeeper or archive Terraform modules, no `archive` function role (`FUNCTION_ROLES` is ingest, api, consumer, record, cron, bootstrap). winterbaume is installed by `scripts/aws-emulated/install.mjs` (pin v0.2.9). | repo tree |
| Erasure | No suppression (`TODO(M4)` at `consumer.ts:382` and `record-handler.ts:195`), no `SubjectIndex`, no reducer, no ledger worker, no erasure API routes. | repo tree |

### 1.2 What the spikes concluded

Engine
- DuckDB 2.0.0 + `iceberg` extension is the engine for local, Lambda and Cloud Run: ATTACH, `INSERT ... SELECT FROM read_parquet(...)`, partition `day(received_at)`, sort order, DELETE, MERGE.
- No Athena engine (cannot read v3). No in-process write path on Workers (M6).
- DuckDB cannot set snapshot summary properties and has no `add_files`; append re-encodes rows. Idempotency therefore rests on the `archive_batch` column plus a partition-pruned `hasBatch` probe (verified on S3 Tables: 1 of 6 files read).
- A session does not see its own commits unless `iceberg_use_metadata_log = false`; commits conflict (also with S3 Tables compaction), so the adapter retries. DDL (partition, sort order, `write.delete.mode`) must run in a separate session before the first INSERT.
- `iceberg_expire_snapshots` is main-only and metadata-only in this build; `iceberg_rewrite_data_files` refuses v3 and works on v2.

Catalog
- S3 Tables via `ENDPOINT_TYPE s3_tables` (SigV4) works end to end (verified on real AWS, ap-northeast-1). Lakekeeper v0.15.1 is the local and self-hosted catalog; needs `sts-enabled: false` and path-style against winterbaume; its maintenance queues may be a paid-edition feature (unverified).
- Lakekeeper with winterbaume as the object store, and DuckDB writing through it, are untested.
- R2 Data Catalog (Basin Catalog) has no documented v3 or DV support; out of M4.

Deletion vectors and erasure
- On v3, DuckDB DELETE writes genuine Puffin `deletion-vector-v1` blobs, merged to one per data file, honored by a fresh DuckDB and pyiceberg. DV masks only: bytes remain.
- `hardErase` on v3 is blocked (no DuckDB rewrite). S3 Tables maintenance was not observed to apply DVs or expire snapshots inside the spike window; minimums are 1 hour (snapshots) and 1 day (unreferenced files). No on-demand trigger exists.
- A raw byte grep is a false negative on zstd and dictionary-encoded Parquet; erasure proof must decode Parquet.
- Spike rows of three projects shared files; per-project file locality is not automatic.

Lambda and Workers
- DuckDB runs on Lambda Node 22, arm64 or x86_64. Recommended packaging is a container image with extensions baked under `extension_directory`, `autoinstall/autoload_known_extensions=false`, `home_directory=/tmp/...`, env-based S3 secret (httpfs only, no `aws` extension), 1024 MB, instance created at module init. Cold start 1.2 to 2.3 s. ZIP with bundled extensions is erratic (init timeouts); ZIP with runtime `INSTALL` into `/tmp` works (2 to 3.5 s) but needs egress.
- Iceberg reads and writes from inside Lambda were not tested (only `LOAD`).
- Workers: no verified in-process Iceberg writer; `icebird` is experimental; Basin SQL is read-only. Defer to M6.

## 2. Slice plan

Rules for every slice (from CLAUDE.md): contract suite first, default `pnpm test` offline with no daemons, opt-in tests skip when the service is absent (suggested switches `ERRTRAQ_LAKEKEEPER=1` / `ERRTRAQ_DUCKDB=1`, or detection of the endpoint and the `@duckdb/node-api` module), `core` and `http` stay free of `node:*` and bundle for Workers (`pnpm` layering check), one `TODO(M4x)` comment where a later slice plugs in, standard gate (`typecheck`, `lint`, `test`) before commit. Slices that share no files can run in parallel; the order below is the dependency order.

```
M4a -> M4b -> M4g -> M4h -> M4i -> M4m
  \-> M4c -----/        ^
M4d -> M4e -> M4f -----/
              M4b+M4g -> M4j -> M4k -> M4l -> M4m
```

### M4a. Archive contracts, row definition and fault-injecting fake

- Goal: pin everything the worker and the engines rely on before any of them exist.
- Scope: `packages/testing` (contracts, fakes), `packages/core` (new `archive-rows.ts`, replacing the M4a staging codec; see the 2026-11-25 decision on staging).
- Contract changes first: extend `archiveStoreContract` with append of an empty batch (rejects, appends nothing), `batchEventIds` (project, batch and day-range scoped), `hasBatch` scoped by `dayRange` (a batch outside the range is not found), repeated append after later batches, append rows spanning several days, `getEvent` without hint, empty-result paging with `hasMore: false`, stable ordering of equal `receivedAt` by `eventId`, and a project-isolation case for `deleteWhere`. Add `EventRepo` contract cases the worker depends on if missing: `scanOlderThan` after partial `deleteBatch`, repeated `deleteBatch`, cutoff exclusivity, scan returns overflow keys. Add a `capabilities.rowDelete` case that asserts the declared mode is the one exercised.
- New in core: `archive-rows.ts`: the archive row (promoted columns from a StoredEvent plus `archive_batch`), `dayRange` and `maxReceivedAt` computation and the batch size bounds. (M4a first shipped a Parquet staging codec; removed in M4b, see the decision below and git history 14c8c9e.)
- Fakes: `FaultyArchiveStore` / `FaultyActiveStore` / `FaultyMeta` wrappers that throw after the Nth call of a named operation (before and after the effect) for the six-step fault matrix; `MemoryArchiveStore` appends rows directly.
- Tests: row definition and size bounds, contract suite on the fake (offline).
- Done: Verification "Contract tests" for ArchiveStore on the fake; row definition and fault wrappers exist for M4b.

### M4b. Archival planner and per-project worker (core)

- Goal: the six-step state machine of "Archival job", engine-independent.
- Scope: `packages/core` (new `archival.ts` and `archive-planner.ts`, cron wiring in `cron.ts`, `archive.project` handler registered in the standalone process; the AWS routing is `TODO(M4i)`), `packages/http` only if the consumer entry lives there. No adapter work.
- Behavior: planner pages `ProjectRepo.list` and sends `archive.project {projectId}` (idempotent key per project and tick). Worker: acquire the lease by CAS on `ArchiveState` (create at version 0 when absent), resume from `batch.state`, loop SCAN, COMMIT (CAS `committing`, then `archive.append` with the rows; `hasBatch` probe first on resume, abandon and rescan under the same batch id when absent), MARK, DELETE (ids from `archive.batchEventIds`), CLEAR (five steps, no staging) until nothing below `cutoff` or ~60% of the budget, then re-enqueue a continuation. Overflow payloads are re-inlined from `BlobStore` at STAGE and their blobs deleted at DELETE (retention-hook handoff, replaces the `TODO(M4)` in `retention.ts`). Lag metric per run. Stale lease holders stop on CAS failure (the COMMIT CAS fences the append). Export `driveBatchToCompletion(projectId, lease)` for the erasure worker (M4j). `archivedThrough` is monotonic.
- Cron `retention` handler: wire `deleteExpiredEvents` for stacks without an archive; with an archive selected it does nothing for events (archival deletes) and only handles hard-retention hooks added in M4h.
- Port changes: none expected. If `scanOlderThan` cannot give a stable cursor-free restart in some adapter, extend the contract instead of the worker.
- Tests (offline): fault-injection matrix killing the worker after each of the six steps (also before and after each CAS) on the memory store, then `store-sql` sqlite (default suite) and DynamoDB (existing emulated suite, opt-in), asserting no loss, no duplicate in the archive fake, empty active store below cutoff; late-event test (insert below the watermark, query before and after the next run); lease expiry takeover; stale-holder append race; continuation message behavior; planner idempotence.
- Done: "Archival crash-safety (M4)" on fakes plus sqlite; TODO items for stale-lease nonce and retention wiring.

### M4c. Federated `EventQueryService` (core) and API wiring

- Status: implemented (2026-11-25). `core/src/event-query.ts`, shared `federationSuite` in `packages/testing`, wired into the API (`createApiApp({ archive })`); platform wiring of the archive into `createApiApp` is M4g.
- Goal: one read path over both tiers, correct across the watermark.
- Scope: `packages/core` (new `event-query.ts`), `packages/http/src/api.ts` (events list, event detail, issue `lastEventId` lookup), `packages/testing`.
- Behavior: always query the active store; query the archive only when the range starts before `archivedThrough` (from `MetaRepo`, cached per request); merge-sort by `(receivedAt, eventId)` in the requested order, dedupe on `eventId`, emit `limit`, resume both sources from the last emitted key via `after`; independent source cursors stay internal. `getEvent` falls back to `archive.getEvent` with `hintTs`. When no archive is configured the service is a pass-through, so existing behavior is unchanged.
- Contract first: a shared federation test suite (not just the current hand merge): random distribution of events over both tiers including duplicates, both orders, page sizes 1 to N, `from` / `to` ranges, `hasMore` accuracy, empty active page with archive rows left, watermark movement between pages.
- Tests: offline with `MemoryActiveStore`, sqlite store and `MemoryArchiveStore`.
- Done: the second half of "Archive (M4)" verification (gapless, duplicate-free, ordered pages across the watermark) on fakes; engine run follows in M4g.

### M4d. Local archive environment and the Lakekeeper + winterbaume feasibility spike

- Goal: close the biggest unverified local risk before writing the engine, and give later slices an opt-in environment.
- Scope: `docker/compose` (Postgres 17, Lakekeeper v0.15.1 `migrate` then `serve`, `allowall`), `scripts/` (bootstrap the Lakekeeper project and warehouse with `sts-enabled: false`, path-style, `s3-compat` flavor, endpoint on the host winterbaume), reuse the existing pinned winterbaume installer and its start/stop helpers, a `.agents-docs` note of results. No product code.
- Spike questions (record the answers in JOURNAL): does warehouse creation pass Lakekeeper's storage validation against winterbaume; can DuckDB 2.0 ATTACH, CREATE TABLE (v2 and v3), INSERT, DELETE and read back through Lakekeeper with `ACCESS_DELEGATION_MODE none` and a static S3 secret (`s3_url_style='path'`); does the Lakekeeper default format-version policy allow v3; are the maintenance task queues available in the open-source image; is `winterbaume-server` stable under DuckDB's multipart and range traffic.
- Tests: none in the default suite; a `scripts/` smoke command that skips with a clear message when Docker, the winterbaume binary or `@duckdb/node-api` is absent.
- Done: smoke passes or the failure is documented with a fallback decision (D11). Resolves "Lakekeeper with winterbaume" untested item and the compose requirements.

### M4e. Iceberg REST catalog client (minimal) and `archive-iceberg` package skeleton

- Status: implemented (2026-11-25). `packages/adapters/archive-iceberg` (`src/catalog/` client, subpath `./catalog`; `create` returns an ArchiveStore that throws `ArchiveEngineNotWiredError`, `TODO(M4f)`). Offline tests green; the opt-in Lakekeeper test (`lakekeeper.opt-in.test.ts`, `ERRTRAQ_LAKEKEEPER_URL`, `docker/archive/compose.ports.yaml`) passed against the M4d stack. The infra descriptor is the local no-module placeholder, `TODO(M4i)` for S3 Tables.
- Goal: the `IcebergRestCatalog` named in ARCHITECTURE, scoped to what errtraq itself needs (the DuckDB engine talks to the catalog on its own).
- Scope: new `packages/adapters/archive-iceberg` exporting the triple `manifest`, `create`, `infra` (kind `archive`, `childKinds` catalog and engine, matching the existing schema); `catalog/` module with `getConfig`, `loadTable`, `createNamespace`, `createTable`, `commit` (updates and requirements) limited to `set-properties`, `remove-snapshots`, `set-snapshot-ref`; auth modes none, bearer and OAuth2 client credentials, SigV4 (reuse `packages/aws-signing`), warehouse and prefix handling, 409 mapped to a retryable error. Web-standard `fetch` only, so it stays Workers-bundleable.
- Port changes: none. If `expireSnapshots` is implemented through `remove-snapshots` (D3), it lives here.
- Tests: offline against recorded request/response fixtures (hand-written from the REST spec plus captures from the M4d spike); opt-in test against Lakekeeper.
- Done: client unit tests green offline, opt-in Lakekeeper test green; export check and layering check pass.

### M4f. DuckDB engine adapter and `ArchiveStore` implementation

- Status: implemented (2026-11-25). Subpath `@moriyoshi/errtraq-archive-iceberg/duckdb` (`src/duckdb/`: `sql.ts`, `attach.ts`, `session.ts`, `store.ts`, `engine.ts`); `@duckdb/node-api` 2.0.1-r.1 is imported statically in `engine.ts` only. The main entry `create` takes the engine through `bindings.createEngine` (`TODO(M4g)` for the standalone wiring); `deleteWhere`, `hardErase` and `expireSnapshots` reject with `UnsupportedQueryError` (`TODO(M4l)`). `archiveStoreContract` gained `erasure?: boolean` (default true); the engine runs it with `erasure: false`. The opt-in contract run (`src/duckdb/lakekeeper.opt-in.test.ts`) passes against Lakekeeper + winterbaume, in the compose network and from the host (`compose.ports.yaml` now also publishes winterbaume on `127.0.0.1:15555`). Deviations: no staging options in the config (D5 superseded); `append` carries rows as one JSON parameter unnested by `from_json` rather than an Appender or temporary table; a repeated append finds its snapshot by time travel (binary search over `iceberg_snapshots`), since DuckDB cannot tag snapshots.
- Goal: the real `ArchiveStore` for local and Lambda, passing `archiveStoreContract`.
- Scope: `packages/adapters/archive-iceberg` engine module, loaded through a subpath export so bundles that do not use DuckDB never import `@duckdb/node-api` (static imports only, per the layering rule).
- Behavior (all from the spikes): instance options (`home_directory` under `/tmp`, `extension_directory`, autoinstall and autoload off in container mode, runtime `INSTALL` mode for dev); env-based S3 secret with optional endpoint, path style and session token; ATTACH variants for Lakekeeper and `s3_tables`; `SET iceberg_use_metadata_log = false`; commit-conflict retry with jitter; table bootstrap (`ensureTable`, run from `errtraq migrate` or a one-shot, in its own session): `events` with promoted columns, `archive_batch`, partition `day(received_at)`, sort order, `write.delete.mode = merge-on-read`, format version from config; `append` as one `INSERT ... SELECT` from the rows passed in (for example through an Appender or a temporary table) with the batch id in `archive_batch`; `hasBatch` as the day-range-pruned count; `batchEventIds` as the day-range-pruned `SELECT event_id ... WHERE archive_batch = ?`; `query` and `getEvent` as keyset SQL (`ORDER BY received_at, event_id`, `after`, issue and range predicates, hint day pruning); small results via `getRowObjectsJson`, large ones streamed. `deleteWhere`, `hardErase`, `expireSnapshots` throw `UnsupportedQueryError` with `TODO(M4l)`.
- Port changes: add the DuckDB-relevant options to the archive config schema (catalog, warehouse, staging location, format version, memory limit, threads). Keep `rowDelete` capability truthful per config.
- Tests: SQL generation and row mapping unit tests (offline, plain SQL strings and an in-memory DuckDB if the module is installed, otherwise skipped); the full `archiveStoreContract` against Lakekeeper + winterbaume via the M4d environment (opt-in).
- Done: contract suite passes against the real engine locally; spike TODO items for `iceberg_use_metadata_log`, conflict retry and separate-session DDL are closed.

### M4g. Standalone wiring and the archive end-to-end

- Status: implemented (2026-11-25). `cronIntervalSec` timers and the default cron handler in the standalone platform, `stacks/local-archive.ts`, `errtraq migrate`, image with the DuckDB binding (D6), opt-in `pnpm e2e:archive` and `duckdb/fault-matrix.opt-in.test.ts` (both passed against Lakekeeper + winterbaume). See the JOURNAL entry for deviations.
- Goal: archival, federation and the engine working together locally.
- Scope: `packages/platforms/standalone` (in-process timers for `archive-planner` and `retention`, queue consumer registration for `archive.project`), `stacks/local-archive.ts` (new example stack, local store + Lakekeeper + winterbaume), CLI (`errtraq migrate` creates the archive table), `scripts/e2e` addition, standalone container image gains the DuckDB native binding (or documents that it does not, D6).
- Tests: default suite uses the in-memory archive and the standalone planner timers; opt-in e2e: seed events, run archival with a short cutoff, assert rows in Iceberg via a separate DuckDB session against Lakekeeper, and a cross-watermark page sequence through the HTTP API; run the M4b fault matrix once more against the real engine for the COMMIT and MARK boundaries.
- Done: "Archive (M4)" verification, and "Archival crash-safety (M4)" including the real `hasBatch` probe path.

### M4h. Archive-side housekeeping and TTL backstop

- Goal: retention beyond the hot tier and tidy-up.
- Scope: core housekeeping job (new cron job name, or extend `retention`) and engine functions; DynamoDB store for the TTL strategy; staging cleanup.
- Behavior: hard retention (`DELETE WHERE received_at < now - archiveRetention`, whole-partition), project deletion (`DELETE WHERE project_id`), snapshot expiry and orphan handling per catalog (S3 Tables automatic, Lakekeeper queues if available, otherwise the engine or `remove-snapshots` from M4e), compaction policy note (D13), orphan `archive-overflow/` manifests and overflow and raw envelope blobs after pipeline crashes, lag alarm. Optional, flagged by D2-style owner call: `deleteStrategy: "ttl"` for DynamoDB, writing `ttlEpoch` only when archive is enabled, using the persisted scan cursor in `ArchiveState`, never before the archive commit, with a durable retention-ceiling policy.
- Contract first: `EventRepo` contract case for TTL strategy semantics (rows disappear only after expiry; the worker treats DELETE as a no-op); housekeeping tests on fakes.
- Done: housekeeping unit tests, opt-in engine tests for retention and project deletion; TTL decision recorded either way.

### M4i. AWS wiring: `archive` role, S3 Tables, container image, Terraform

- Goal: the generated stack can deploy the archive tier.
- Scope: `packages/core` (new always-split `archive` function role, topic route for `archive.project`, requirement rows, validation), `packages/platforms/aws-lambda` (container-image packaging for selected roles, EventBridge triggers for the archive cron jobs, queue mapping with limits and timeouts), `packages/adapters/archive-iceberg` `infra` descriptor, `infra/modules/aws/<s3tables|archive-lambda>` HCL (table bucket, namespace, maintenance configuration, ECR repository, image function variant, IAM for `s3tables:*` REST actions, `GetTableData`/`PutTableData`), `packages/infra-gen` snapshots, `packages/cli` build for the image (Dockerfile generation plus extension baking per the spike recipe, arm64).
- Contract first: infra-gen snapshot tests, `terraform validate` on the generated root, security-contract and mutation tests for the new policies (existing scripts).
- Tests: offline snapshots and validation; winterbaume plan checks only for the parts it supports (it has no S3 Tables or ECR, so record the gap in `WINTERBAUME_GAPS.md`).
- Done: `stacks/aws-dynamodb-archive.ts` (name indicative) generates and validates; nothing applied.
- Status (partial, 2026-11-25): the Terraform piece is implemented on `m4i-tf`. `infra/modules/aws/s3tables` (table bucket, namespace, bucket-level unreferenced-file-removal maintenance, TLS-deny bucket policy, `read` / `write` / `delete` policy documents), the real AWS `infra` descriptor and `s3TablesArchive()` selection in `archive-iceberg/src/stack.ts` (`icebergArchive()` keeps the local and existing-catalog case), module tests, shape snapshot, mutation entries, a generated-root fixture (`s3tables-archive`) and `stacks/aws-s3tables-archive.test.ts`. Terraform does not create the `events` table (the engine's `ensureTable` does), so table-level compaction and snapshot settings are exported as `table_maintenance` but not applied (`TODO(M4l)`). Grants are keyed by capability; the archive requirement rows currently resolve to the `consumer`, `cron` and `api` roles, so the `archive` role only needs adding to the role set. Still open in M4i: the `archive` function role, container-image packaging, EventBridge triggers, the CLI image build, the requirement-row cleanup and `stacks/aws-dynamodb-archive.ts`.

### M4j. Erasure ledger, suppression and archive-side mask (core)

- Goal: the two-phase ledger without the physical path.
- Scope: `packages/core` (new `erasure.ts`, KV suppression, consumer and record-handler suppression before rate limiting and before publish, resolving both `TODO(M4)` comments), `packages/http` (`POST/GET /api/0/projects/{org}/{project}/erasure-requests/`, token scopes), cron `erasure-worker` handler.
- Behavior: states `received`, `active-purged` (under the archive lease, `driveBatchToCompletion` first), `archive-masked` (`deleteWhere`, `maskSnapshotId`, file list in a blob key), `archive-erased` (calls `hardErase` and `expireSnapshots`, implemented in M4l), `done` (selector replaced by a salted hash). Every transition is a CAS; the worker resumes from state. Completion is gated by the drain policy (D8). Uses a `SubjectIndex` interface with an in-memory fake until M4k; selector kinds `eventIds` and plaintext fields only through the fake.
- Port changes: change `ArchiveStore.deleteWhere` to the reduced-key selector union from SUBJECT_INDEX_DESIGN (`ArchiveErasureSelector`); update the contract suite and the fake in the same commit; change `EventRepo.capabilities.deleteBySubject` from literal `false` to boolean.
- Tests: fault injection across each state transition (kill after each CAS and each side effect), race of erasure with an in-flight batch (Verification (e)), suppression in both consumer modes, idempotent re-runs, ledger holds no PII after `done`.
- Done: Verification Erasure (a), (d), (e) on fakes.

### M4k. Subject index, reducer and store erasure operations

- Goal: let the active store find and delete a subject's events.
- Scope: `packages/core` (`SubjectReducer`, `SubjectIndex` port, Parquet-on-BlobStore default implementation, inline consumer append before ack including the duplicate-repair path, manifest CAS in `MetaRepo`), `packages/testing` (new contract suites), adapters `store-sql`, `store-dynamodb`, memory (`deleteBySubject`, `IssueRepo.repairAfterErasure` count-preserving pointer repair, overflow key return), a pure-JS Parquet writer and reader dependency (candidate `hyparquet-writer`/`hyparquet`, needs a Workers bundling and bloom-filter check before adoption; justify in the report).
- Contract first: `SubjectIndex` contract, reducer vectors (email, IP, Unicode, pepper isolation and rotation), `deleteBySubject` and `repairAfterErasure` cases in the `activeStoreContract`.
- Tests: offline; Parquet interoperability check reading a written file with DuckDB is opt-in.
- Done: stage 4 of `SUBJECT_INDEX_DESIGN.md`; DynamoDB subject-erasure semantics; blob list and read consistency and lease-fenced manifest operations verified (fake plus emulator), with the main-queue drain item resolved per D8.
- Note: largest slice; split into reducer plus index, then store operations, if the review budget demands it.

### M4l. Engine erasure: deletion vectors, `hardErase`, `expireSnapshots`

- Goal: real masking and the chosen physical erase path on the DuckDB engine.
- Scope: `archive-iceberg` engine (DELETE by reduced keys or event ids, files list from the new delete manifest entries via `iceberg_metadata`/`read_avro`, snapshot id from the REST commit response), the hardErase strategy chosen in D3, `expireSnapshots` via D3's choice, `capabilities.rowDelete` derived from the table format, verification helper that decodes Parquet (not byte grep).
- Contract first: extend `archiveStoreContract` with a physical-removal assertion that is capability-aware (masked immediately; after `hardErase` + `expireSnapshots` no object under the table location contains the subject when decoded), as opt-in for real engines and unconditional on the fake.
- Tests: opt-in against Lakekeeper + winterbaume: Verification Erasure (a) to (e) with the snapshot check that a v3 DV commit has Puffin DVs and no rewritten data files (only when the table is v3).
- Done: Verification "Erasure (M4)" complete locally, or its remaining gap named per D3 and recorded as a TODO with an owner-approved SLA statement.

### M4m. Real AWS verification

- Goal: Verification parity with M3h for the archive tier.
- Scope: operator-run apply of the archive stack into the sandbox account (S3 Tables, container Lambda, EventBridge, queue), no code beyond fixes.
- Checks: Iceberg append, query and DELETE from inside Lambda (untested by the spike), image cold start and `/tmp` use, least-privilege IAM for S3 Tables (list the actions actually needed, including data access), commit conflicts against S3 Tables compaction, archival e2e with real SQS, cost sample against `COST_ESTIMATE.md`, the multi-day maintenance experiment on physical erase (D9), DynamoDB TTL/encoding/sharding verification and the PITR note.
- Done: JOURNAL entry with measurements; TODO items updated; destroy inventory clean.

## 3. Owner decisions

Each item lists options, a recommendation and why. Items marked "before" block the named slice.

Owner decisions taken 2026-11-25:

- D3: Iceberg format v3 from the start, as ARCHITECTURE specifies (not the v2 default recommended
  below). Consequence: no erasure-completion deadline can be promised until a v3 physical-erase path
  is proven (M4l / M4m); M4l must find one (catalog maintenance applying DVs, or another verified
  rewrite) rather than fall back to v2.
- D5 (superseded, same day): the Parquet staging decision was dropped. No staging for M4: the
  archival worker passes the rows straight to `ArchiveStore.append({ batchId, dayRange, rows })`; the
  batch state machine has five steps (SCAN, COMMIT, MARK, DELETE, CLEAR); the committed snapshot
  (rows tagged `archive_batch`) is the record the DELETE step reads via the new
  `ArchiveStore.batchEventIds`. The M4a codec, `hyparquet` and `hyparquet-writer` were removed.
  Costs: one archive read per DELETE; engines that need a file to commit (native committer,
  Cloudflare) are out of M4 and would reintroduce staging as an engine option.
- D6: a dedicated, always-split `archive` function role on a container image runs the worker,
  erasure and housekeeping; `archive.project` routes to it instead of `consumer`. The `api` role
  gets archive read access for federated queries. ARCHITECTURE must be updated in the slice that
  lands it (M4i at the latest).
- D7: erasure stays in M4, sequenced after M4i, with a go/no-go checkpoint before M4j.
- The other recommendations (D1, D2, D4, D8, D10 to D14) stand as written unless the owner changes
  them; D9 (the multi-day S3 Tables maintenance experiment) is not approved yet.


D1. Default engine per platform (before M4f). Options: DuckDB everywhere it runs; DuckDB plus a native committer; DuckDB plus a remote engine for Workers. Recommend DuckDB for local, Lambda and Cloud Run, nothing for Workers in M4. Reason: only verified path, matches ARCHITECTURE.

D2. Catalog targets for M4 (before M4d). Options: Lakekeeper local plus S3 Tables on AWS; add Glue REST; add self-hosted Lakekeeper on AWS; add R2 Data Catalog. Recommend Lakekeeper locally and S3 Tables on AWS only. Reason: both are verified or cheap to verify; Glue REST docs still say v1/v2; R2 has no documented v3 or DV and belongs to M6. Self-hosted Lakekeeper on AWS needs a service and Postgres module that no slice here budgets.

D3. Table format version and the `hardErase` path (before M4f; the most consequential decision). Options: (a) v3 with DVs and rely on catalog maintenance; (b) v3 with copy-forward into a new table (untested); (c) v2 table with position deletes, DuckDB `iceberg_rewrite_data_files` for physical erase (verified on S3 Tables), snapshots expired by catalog maintenance or REST `remove-snapshots`; (d) wait for DuckDB v3 rewrite; (e) native rewrite committer. Recommend (c) as the M4 default behind a `formatVersion` config, with `rowDelete: "position-delete"`, keeping v3 opt-in until either DuckDB supports v3 rewrite or the maintenance experiment (D9) shows physical removal. Reason: it is the only path with verified physical removal; the capability already exists to degrade and the ledger and API do not change; v2 is also readable by Athena. Cost: deviates from ARCHITECTURE ("created as Iceberg format v3"); an in-place v2 to v3 upgrade works but afterwards rewrite is refused, so the upgrade is a one-way door; position-delete Parquet files accumulate until rewrite. If the owner wants v3 now, choose (a) and accept that the erasure SLA cannot be promised before M4m.

D4. Native committer now or later. Recommend later (not in M4). Trigger conditions to revisit: DuckDB still refuses v3 rewrite when v3 is wanted, a need for summary-property idempotency, or Workers writes (M6). Reason: DuckDB covers append, query, DV delete and the batch-id probe works; the minimal REST client in M4e already leaves the door open.

D5. Staged batch format (before M4a). Options: gzip NDJSON of `StoredEvent` (core can write it with `CompressionStream`, DuckDB reads it with `read_json` and explicit columns); Parquet via a pure-JS writer in core. Recommend NDJSON for M4 and adopt Parquet when M4k brings the writer in. Reason: ARCHITECTURE says Parquet but core has no Parquet writer and no dependency is chosen; DuckDB re-encodes on INSERT anyway, so Parquet staging only pays off with a native committer. The id list for DELETE is trivial from NDJSON.

D6. Where DuckDB runs on AWS and how it is packaged (before M4i). Options: new always-split `archive` role (worker, erasure, housekeeping) as a container image, and the `api` role also gets the image for federated queries; or API calls the archive function; or keep the worker in the shared `consumer` function. Recommend a dedicated `archive` role on a container image (arm64, 1024 MB, extensions baked in) and reuse the same image for the `api` role only when an archive is selected; reject ZIP with bundled extensions. Reason: spike shows the ZIP bundle path times out in init; the shared consumer would force a 200 MB native payload on the hot ingest path; ARCHITECTURE routes `archive.project` to `consumer`, so this changes `TOPIC_ROUTES`. Fallback if images are unwelcome: ZIP with runtime `INSTALL` into `/tmp` and egress to extensions.duckdb.org.

D7. Does erasure ship in M4 (before M4j). Options: all of M4j to M4l inside M4; ship tiering (M4a to M4i) first and erasure as a follow-up milestone; ship only the archive-side mask. Recommend keeping erasure in M4 but sequenced after M4i with a go/no-go checkpoint at M4i, and calling the milestone complete only when D8 and D3 are settled. Reason: ARCHITECTURE and Verification include it; it is the least certain work and should not block a usable archive tier.

D8. Main-queue drain proof (before M4k). Options: (a) leave the request pending until an operator confirms; (b) a deadline rule: `done` only after `requestedAt + main-queue retention + margin` with the suppression record retained until then and DLQ checks; (c) a new Queue capability exposing a provable inventory (not available on SQS). Recommend (b) with (a) as the manual override. Reason: messages leave an SQS queue after retention (max 14 days, inferred from AWS docs, not verified here), which fits the 30-day window, needs only a `Queue.capabilities` retention field, and removes the false-complete race. Needs an owner statement of the privacy guarantee ("eventually reconciled, with suppression durable").

D9. Physical-erase measurement. Start a multi-day S3 Tables experiment now, in parallel with M4a to M4c (create a table bucket, v2 and v3 tables, apply deletes, lower maintenance to the 1 hour and 1 day minimums, poll for days, record whether bytes disappear and the end-to-end time). Reason: its outcome decides D3 and takes calendar days, not engineering hours. Needs owner approval for the AWS account (CLAUDE.md forbids touching cloud accounts without it).

D10. Local compose requirements (before M4d). Options: compose runs Postgres, Lakekeeper and a locally built winterbaume image; or compose runs only Postgres and Lakekeeper and winterbaume runs on the host from the pinned release. Recommend the second. Reason: there is no published winterbaume image, the pinned installer and process helpers already exist, and Lakekeeper reaches the host emulator via `host.docker.internal`. Requires Docker or Podman for opt-in tests only; the default gate stays daemon-free. Check the Lakekeeper arm64 image on Apple Silicon.

D11. Fallback object store if Lakekeeper rejects winterbaume (before M4d result). Options: patch or file issues upstream and wait (owner owns winterbaume); use Lakekeeper with a different S3-compatible server; skip Lakekeeper locally and test the engine against a REST catalog stub plus real AWS only. Recommend upstream fix first, since the project owner maintains winterbaume, with the third option as a temporary gate. CLAUDE.md forbids MinIO, so any alternative server needs explicit approval.

D12. Retention semantics with an archive (before M4b). Today `Project.retentionDays` is one number. With an archive it should mean hot-tier age (archive when older), and a new stack-level and per-project `archiveRetentionDays` should bound total life. Options: reuse `retentionDays` as hot age and add `archiveRetentionDays`; or keep `retentionDays` as total life and add `hotDays`. Recommend the first. Reason: matches the archival cutoff language in ARCHITECTURE ("older than a per-project retention") and the existing project API; need a policy for retention increases (relevant to the TTL backstop).

D13. Table sort order and compaction (before M4f). ARCHITECTURE sorts by `(issue_id, received_at)` yet relies on single-project files for pruning and cheap erasure; automatic compaction can merge projects. Recommend sort order `(project_id, issue_id, received_at)`. Reason: keeps per-project locality through compaction; negligible cost.

D14. TTL backstop in M4 (before M4h). Options: ship `ttl` strategy for DynamoDB in M4h; defer. Recommend defer to after M4m. Reason: explicit deletes work, TTL needs a durable retention-ceiling policy and the data-loss alarm, and DynamoDB items written before activation have no TTL.

## 4. Risks and unknowns

1. Lakekeeper with winterbaume untested (TODO "untested by the spikes"; research section C and 8.5). Validation probes, presigned URLs and chunked uploads may fail; vended credentials cannot be tested realistically. Mitigated by M4d first.
2. Physical erasure on v3 unproven (TODO "decide the physical-erasure (`hardErase`) path"). Compaction ran once and never again in 26 minutes; DV-only snapshots never compacted; no on-demand trigger. SLA floor at least 1 hour plus 1 day on S3 Tables, 24 hours on Lakekeeper queues. See D3 and D9.
3. DuckDB extension churn: 2.0.0 regressions, maintenance features only on `main` (research 7.3). Pin DuckDB and extension versions; test rewrite-after-delete explicitly; the container image bakes exact extension builds.
4. Idempotency without summary properties relies on the `archive_batch` column and single-writer discipline (TODO "DuckDB archive engine must set ..."). The lease fences only `ArchiveState` CAS, not the engine append: an append by an expired holder is caught by `hasBatch`, but an append landing after an erasure mask could resurrect erased rows from a still-existing staged object. M4j must delete or neutralize staged objects touched by an erasure and test the race (Verification (e)).
5. `hasBatch` false-negative if every row of a committed batch is later masked or the day partition is dropped; fine under the lease discipline, but housekeeping and erasure must never run against a project holding a `staged` batch (same lease rule).
6. Per-project file locality not guaranteed (spike: three projects per file). Affects erasure cost and pruning; see D13.
7. Lambda untested for Iceberg I/O, memory (a 50k-row batch needed about 440 MB), and `/tmp` pressure; DuckDB `threads` stays 2 (TODO "untested by the spikes"; DUCKDB_LAMBDA_SPIKE untested list).
8. Same-session stale reads and commit conflicts with compaction (TODO "DuckDB archive engine must set ..."): retry policy and metadata growth, one snapshot per erasure DELETE.
9. Main-queue drain proof and Parquet index consistency (TODO "resolve the main-queue drain proof"). Without D8, erasure cannot honestly reach `done`.
10. PITR keeps erased DynamoDB data up to 35 days; raw envelopes, staging objects, old Iceberg snapshots and overflow blobs are other PII copies (TODO "M3h / M4 ... PITR retention"; SUBJECT_INDEX_DESIGN: reduced or dropped promoted fields do not scrub nested payload).
11. Erasure verification as written in ARCHITECTURE ((c) raw byte scan) gives false negatives on compressed Parquet; the proof must decode (S3TABLES_DV_SPIKE 6c).
12. `TODO` event TTL: activating `ttlEpoch` before archive commit loses data; items written earlier have no TTL; retention increases are unsettled (TODO first M4 item).
13. IAM: S3 Tables actions seen in CloudTrail were observed with an admin role only; least-privilege untested (TODO "untested by the spikes").
14. Workers (M6): nothing in M4 may import `node:*` or DuckDB from `core`/`http`; the engine sits behind the `archive-iceberg` subpath. Cloudflare write and DV support remain unverified (research section 8, item 1).
15. Test cost: the opt-in suites need Docker, the winterbaume binary and the 96 MB DuckDB binding; keep every default-suite path free of them.

## 5. TODO.md mapping

Line numbers are as of this writing and may shift; the text is the key.

| TODO item (open, M4) | Resolved by |
|---|---|
| Activate the event `ttlEpoch` backstop with the archiver (line 17) | M4h (optional per D14; recommended after M4m) |
| Resolve the main-queue drain proof; verify blob list/read consistency and lease-fenced manifest operations for the Parquet index (line 34) | M4k, policy per D8 |
| Spike: DuckDB appends through a REST catalog against Lakekeeper and S3 Tables; what Workers can do against R2 Data Catalog (line 49) | S3 Tables part done by the spike; Lakekeeper in M4d and M4f; R2 / Workers out of M4 (M6) |
| Spike: which engines write and honor v3 DVs; decide native committer (line 50) | Answered by the spikes for DuckDB (writes and honors DVs; Athena cannot read v3); native committer closed by D4; formal closure in M4l |
| Prevent stale lease holders overwriting staging batches (line 55) | M4a (nonce keys) and M4b (CAS stop) |
| Act on `M4_ICEBERG_SPIKE_RESEARCH.md` (Athena, winterbaume binary, `sts-enabled: false`, Cloudflare) and revise the ARCHITECTURE engine list (line 57) | M4d (compose and Lakekeeper settings); ARCHITECTURE revision by the `distill-memories` pass after M4g and D1 to D3 |
| Remove orphaned raw envelope and overflow blobs after pipeline crashes (line 60) | M4b (overflow handoff) and M4h (lifecycle and sweeps); raw envelope orphans may stay with the existing `staged-recovery` and lifecycle rules |
| Investigate raw-deflate clients (line 64) | Out of M4 (ingest fix, independent of archive; schedule as a small standalone task) |
| Decide the physical-erasure (`hardErase`) path for v3 tables (line 66) | Decision D3 and D9, implemented in M4l, measured in M4m |
| DuckDB engine settings and Lambda packaging (line 67) | Settings in M4f; image packaging in M4i |
| Untested by the spikes: Lambda Iceberg I/O, Lakekeeper + winterbaume, Athena / Spark readers, least-privilege S3 Tables IAM (line 68) | Lakekeeper + winterbaume in M4d; Lambda and IAM in M4m; Athena excluded by design (v3, or v2 under D3); Spark as a reader out of M4 |
| Implement DynamoDB subject-erasure semantics (line 77) | M4k |
| Verify sortable encodings, projections, sharding, transaction limits on AWS; document PITR retention for erasure (line 87) | Verification in M4m; PITR documentation in M4j |
| Wire the `retention` cron job to `deleteExpiredEvents`; hand overflow blob keys to archive and erasure hooks (line 104) | M4b (wiring and archive hand-off), M4h (hooks), M4j (erasure hook) |
| Suppression remains `TODO(M4)` in the consumer and record handler (line 141 context; `consumer.ts:382`, `record-handler.ts:195`) | M4j |
| Code TODOs: `stack-model.ts:55` (cron handlers), `stack-requirements.ts:169` (archive workers, suppression, archive-aware queries), `retention.ts:36` | M4b / M4h / M4j / M4i respectively |
