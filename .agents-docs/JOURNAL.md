# errtraq Development Journal

Append-only log of findings, insights, decisions, and peer code review history. Add new
entries at the end as `## YYYY-MM-DD — <title>`. Do not edit existing entries. The
`good-sleep` skill consolidates entries into `.agents-docs/LTM/`.

---

## 2026-11-21 — Project bootstrap decisions

- Language is TypeScript because it is the only candidate (vs. Go, Rust) that runs natively on
  every target platform, Cloudflare Workers and Vercel included.
- The Iceberg catalog is always reached through the Iceberg REST catalog protocol so that
  Lakekeeper works, along with S3 Tables, Glue REST, and R2 Data Catalog.
- Cloud order: AWS first, then Cloudflare. Local standalone comes before both.
- The IaC layer generates a Terraform root (module composition + tfvars) from the stack config;
  the modules themselves are hand-written HCL.
- Sentry scope for the first milestones: error events, releases, and sourcemaps.
- Local S3 emulation uses winterbaume instead of MinIO. It supports path-style addressing only,
  so every S3 client in the stack (blob adapter, Lakekeeper warehouse, DuckDB, the Terraform AWS
  provider) must force path style.
- End-user PII erasure must use Iceberg v3 deletion vectors. Deletion vectors only mask rows, so
  the design pairs them with a later physical rewrite and snapshot expiry.
- Least-certain area: which engines can write and honor v3 deletion vectors through a REST
  catalog (DuckDB iceberg extension, Athena / S3 Tables, R2 Data Catalog). To be settled by the
  M4 spike; a native committer is the fallback.
- Working model: Claude Code orchestrates and reviews; a Codex session implements one milestone
  slice at a time, with one commit per slice requested in each brief.
- The agent harness (AGENTS.md layout, agent docs, `.agents/skills`, `.agents-workspace`)
  was adopted from the sibling `cornus` repository and adapted from Go to the pnpm / TypeScript gate.

## 2026-11-21 — M0b: contract decisions in core ports and stack config

Decisions taken where ARCHITECTURE.md left the contract open (implemented by Codex, revised
after review by Claude):

- Ids, `Timestamp` (UTC ISO 8601 instant), `Day`, and `Cursor` are branded strings. `Page<T>`
  has a nullable `nextCursor`; the federated cursor keeps separate active and archive positions.
- Queue `Message` is `{ key, body }` where `key` is a generic idempotency key, because not every
  message is an event (archival sends `archive.project`). A `Queue` exposes its consumer side as
  optional `pull` / `push` sources, matching `capabilities.delivery`.
- There is no `Scheduler` port. `schedule()` / `cancel()` does not fit serverless, where cron is
  declared in infrastructure. Core exports a static `CronJob` table type and a `CronHandler`;
  scheduling is a platform concern (an infra trigger of kind `cron`, or an in-process timer on
  the standalone platform).
- `MetaRepo` compare-and-set takes `expectedVersion: number | null`; `null` means "create if
  missing". Unfinished erasure requests are listed by state with a cursor for the cron job.
- `ProjectKey` stores no DSN (it depends on the serving host). API tokens are looked up by hash.
- `SubjectSelector` is a tagged union; a completed `ErasureRequest` keeps only a selector hash.
- `BlobStore.put` accepts `Uint8Array | ReadableStream` plus an optional size hint, because
  S3-style stores need a known length.
- A stack selection is `{ manifest, infra, runtimeModule, config, existing? }`: everything
  infra generation and the build need, without importing adapter runtime code. `existing` is user
  input on the selection, not part of the `InfraDescriptor`.
- Runtime, compute mode (`function` / `long-lived`), and the deployed function roles
  (`ingest` / `api` / `consumer` / `cron`) belong to the `PlatformManifest`. `validateStack`
  checks port kind, runtime support, adapter config schemas, pull-only queue vs. function
  compute, capability requirements, that grants and triggers reference deployed roles, and that
  `existing` bindings cover exactly the descriptor's binding names.
- Tooling: `pnpm typecheck` also type-checks test files through `tsconfig.tests.json` (no emit).
  The layering check uses the TypeScript type checker so only references to the real `Buffer` /
  `process` globals are flagged, not same-named properties or local bindings.
- Codex sandbox constraints observed: it cannot write to `.git` or `.agents/`, and it has no
  registry access (installs run offline from the local cache). Commits and journal entries are
  therefore made by the orchestrator.

## 2026-11-21 — Agent docs live in `.agents-docs/`

The agent documents (OVERVIEW, JOURNAL, TODO, QUALITY_GATE, LTM) live in `.agents-docs/` at
the repository root, unlike cornus where they are under `.agents/docs`. The Codex sandbox
treats `.agents/` as read-only, so agents could not append to the journal there. (They were
briefly placed in `docs/`; that name stays free for a user-facing docs site.) Skills stay under
`.agents/skills`.

## 2026-11-21 — M0c: contract harness and memory semantics

- Archive adapters own their staged batch encoding and push queues receive platform-specific
  events, so the reusable suites accept staging and push-delivery hooks. The memory archive
  uses JSON test batches, not the Parquet format planned for production. Its snapshot expiry
  is a no-op because it does not retain historical snapshots; the M4 raw-storage erasure
  and crash-safety checks remain necessary.
- Issue lists use descending sort with issue ID as a tie-breaker and a half-open time range on
  `lastSeen`. Event lists and archival scans use ascending `(receivedAt, eventId)`; scan cutoff
  is exclusive, while subject erasure includes events at the request timestamp. The contract
  treats a scan limit as a bound on the returned batch.
- The metadata fake requires an initial version of zero and increments of one; CAS races are
  tested for archive and erasure records. A resolved issue regresses only for an occurrence
  whose client timestamp is after `resolvedAt`.
- `tagFilter: indexed-only` does not identify which tag keys are indexed, and `Issue` has no
  promoted tags. The fake rejects tag queries; the unsupported-filter test uses an unindexed
  key. The index and filtering contract needs refinement before M1 adapters expose tag filters.
- Delay and TTL suites require a controllable clock; tests use an explicit advance hook. Queue
  push coverage also needs a platform event driver. Vitest is a peer of the testing package
  because its exported suite factories register Vitest tests.
- Blob listing and erasure-state listing originally had cursors but no page-size control;
  optional limits were added to their ports so contract suites can force and verify pagination.

## 2026-11-21 — M0c review: delivery, scan and pagination contracts

- Event insertion returns whether the row was newly inserted, and duplicate inserts preserve
  the original row. This permits a consumer to detect redelivery, but the insert and issue bump
  are separate operations: a crash between them still needs an M1 recovery or atomicity design.
- Regression uses server `receivedAt`, not the client timestamp. The scan port now returns one
  page per call, with explicit cursor and limit; the port comments document ordering, boundaries,
  latest-event selection and CAS version rules. Queue deliveries retain their topic.
- Project and release listings gained optional limits so suites can force multiple pages without
  relying on a fake-specific default. Blob and erasure listing limits were added earlier in M0c.
- Repeated archive append of the same batch ID is now required to be safe. Archive suite hooks
  remain responsible for staging each adapter's native batch format; the fake preserves the
  original append result after a physical rewrite.

## 2026-11-21 — M0d: atomic ingestion and M0 review fixes

- Ingest is one atomic `recordEvent` operation; deterministic issue IDs are supplied by core,
  and duplicate events do not bump or reopen issues. Concrete adapters must implement the
  operation using their native transaction or atomic batch. The M1 hash and numeric project ID
  allocation remain future work.
- Event queries use exclusive `(receivedAt, eventId)` keysets and descending order by default.
  The same key can resume both active and archive sources after a partial merge; the contract
  covers interleaved and duplicate events. Erasure is bounded, returns per-issue counts and
  overflow keys, and issue repair preserves the old pointer when no active event remains.
- Push sources now own platform-specific async acknowledgement; KV increments and blob byte
  ranges are port operations. Issue tag filtering is deferred, and non-lastSeen sorts reject
  lastSeen ranges unless explicitly supported. Canonical timestamps are restricted to four-digit
  years to preserve chronological string ordering; `toTimestamp` rejects extended-year dates.
- Stack validation now rejects malformed structures, refs, bindings, capabilities and triggers,
  catches schema failures, and resolves parsed adapter configurations. Existing bindings can
  substitute a trigger output only when the descriptor maps that output to a supplied binding.
  Grants have no source field in the current model; the broader infra redesign is deferred to M2a.
- Core and HTTP typecheck against WebWorker libraries without automatic Node types. Layering
  uses a bare-import allowlist and checks adapter and platform boundaries. Tests use development
  export conditions to load source; production builds use `dist`. A no-dist copy passed typecheck
  and tests using copied installed dependencies; a fresh offline install was blocked by missing
  cached tarballs, so registry-backed installation still needs verification in a networked clone.
- The in-memory active store also runs the shared contracts with the TTL strategy and a fake
  clock, so event expiry is exercised. Vitest excludes local agent workspaces and pnpm stores
  to avoid discovering temporary verification copies as additional test suites.

## 2026-11-21 — M0 closed: final review, verification and research

- M0 (slices M0a to M0d) was reviewed three ways: slice-by-slice by the orchestrator, by an
  independent reviewer that walked the ports through the ingest pipeline, the archival and
  erasure state machines, DynamoDB and SQL adapters and Terraform generation, and by re-review
  of the resulting fixes (M0d). Findings that were not fixed are recorded in TODO.md (the M2a
  infra-model redesign and the M4 staging overwrite).
- Clean-clone verification, done by the orchestrator with registry access (the Codex sandbox
  has none): a fresh copy of the tracked files, `pnpm install --frozen-lockfile`, then
  `pnpm typecheck`, `pnpm lint` and `pnpm test` (93 tests) all pass with no `dist` present, and
  `pnpm build` then emits `dist`. Workspace packages resolve from source in tests (the
  `development` export condition) and in typecheck (`paths`), and from `dist` only after a build.
- ARCHITECTURE.md was updated to the final M0 port shapes: atomic `recordEvent`, core-minted
  issue ids, numeric project ids, canonical timestamps, keyset event paging for federation,
  `PushSource.handle`, no scheduler port (a static cron job table instead), bounded
  `deleteBySubject` with issue repair, and a nonce in the archive staging key.
- Desk research for the M4 spike is in `.agents-docs/M4_ICEBERG_SPIKE_RESEARCH.md`. It is from
  documentation and source reading only. Headlines: DuckDB 2.0 attaches REST catalogs and
  writes v3 deletion vectors but cannot set snapshot summary properties (so append idempotency
  stays with the `archive_batch` column and pre-check); Lakekeeper supports a custom S3
  endpoint with path-style access and runs its own maintenance queues; S3 Tables supports v3
  and its compaction applies deletes; Athena cannot read v3; Cloudflare's catalog is the weak
  spot. Hands-on spikes (DuckDB on Lambda, deletion vectors on S3 Tables) are in progress.

## 2026-11-21 — M1a: SQLite store and tooling boundaries

- The Kysely SQLite dialect wraps `node:sqlite` statements; Node 22 does not expose the newer
  statement column metadata API, so the wrapper classifies the query forms emitted by Kysely.
  File databases enable WAL and a five-second busy timeout. The schema uses indexed promoted
  columns and JSON records, and metadata compare-and-set uses conditional writes.
- SQL advertises `lastSeenRangeOnOtherSort: false`: a range on last-seen while ordering by a
  different key would require scanning that ordering or a separate sort, so the store rejects
  it rather than promising a bounded index-backed access pattern.
- Node-only packages have a separate no-emit typecheck with Node types; core and HTTP retain
  their independent WebWorker-only check. The SQL adapter declares Zod directly because its
  stack helper validates configuration; Zod was already a workspace dependency.
- The offline frozen install needed an explicit denial of the unrelated esbuild build script
  (`--allow-build '!esbuild'`); no new dependency was fetched from the network.

## 2026-11-21 — M1b: local queue, blob and KV adapters

- The queue is pull-only, preserves topics, retries failed or unacknowledged messages, and exposes
  a snapshot of in-flight deliveries. It uses an injectable clock and a short poll so test clocks
  can advance without real-time delays; abort waits for an active handler to finish.
- Filesystem blob keys are SHA-256 encoded into a flat directory, including absolute, traversal
  and NUL-containing keys. Each object contains a small key/content-type header followed by the
  streamed bytes, so a temp-file rename replaces body and metadata together. Opens do not follow
  symlinks, and the configured root is resolved to its canonical directory.
- Memory KV increments are synchronous atomic map updates with TTL applied on creation. The
  production adapters do not import testing fakes; separate reference implementations preserve
  independent contract coverage. Stack helpers are separate subpath exports without runtime code.
- Each stack helper declares the already-present Zod dependency directly. The workspace now
  explicitly permits the already-installed esbuild postinstall; unlike the temporary denial in
  the M1a install attempt, the final frozen offline install runs its local setup successfully.

## 2026-11-21 — M1c ingest pipeline

- Envelope item lengths are bytes, with newline-delimited fallback. Header and event IDs must
  agree; absent IDs are generated as random 32-digit hex values. Unsupported item types are
  accepted and logged as dropped. Authentication uses the query key or `X-Sentry-Auth`.
- Grouping hashes JSON-encoded grouping components with SHA-256, then hashes the project ID
  and fingerprint to obtain the issue ID. Client fingerprints replace the default grouping and
  expand `{{ default }}`; exception frames prefer in-app frames, then all frames, then filenames.
- Defaults are a 1 MiB envelope limit, 60 events per key per 60 seconds, and a 200,000-byte
  payload overflow threshold. Rate limits use fixed windows and KV atomic increments. Core and
  HTTP limits are independently configurable and must be kept consistent by the platform.
- Raw envelopes use unique claim-check keys. A completion marker is written before deleting a
  staged envelope so redelivery, including unsupported-only envelopes, is acknowledged safely.
  Markers currently do not expire: cleanup requires a queue-retention policy. Ambiguous queue
  publication or event-store failures can leave staged or overflow blobs for later cleanup.
- Malformed events are logged and acknowledged as poison; storage and queue failures retry.
  Messages for other topics are retried rather than acknowledged by the ingest consumer.
  Gzip and deflate use Web `DecompressionStream`; Brotli is accepted only if that runtime
  supports it, and otherwise returns 415. The current Node runtime does not support Brotli there.
- Bootstrap allocates numeric IDs with KV increment and checks for pre-existing IDs after a KV
  reset. Lookup-then-put for org/project slugs is not atomic across concurrent bootstrappers;
  the caller must supply a cryptographically secure IdGen for public keys. Both are tracked for
  M1d. No core ports or shared adapter contracts changed; the in-process test uses existing fakes.

## 2026-11-21 — M1e adapter review fixes

- Issue updates now use the same write transaction as event recording and erasure repair.
  SQLite write transactions begin immediately; a 20 ms synchronous busy timeout is followed by
  at most seven asynchronous retries with capped backoff. Versioned migrations apply the original
  schema and directional/unique indexes as separate transactions and reject newer schemas.
- SQL and reference fakes use scoped opaque keyset cursors and reject malformed cursors or limits
  outside 1 through 10,000 with `InvalidCursorError`. Inserts or deletes before the cursor no longer
  shift offsets. A mutable sort key can still cross the cursor between requests: exact snapshot
  pagination requires persistent snapshot or version history and is tracked for M1d.
- Natural-key duplicates owned by another record raise `ConflictError`; an existing ID can be
  updated. SQLite ID lists are chunked below the dialect's 900-parameter limit. Query-plan tests
  cover both event orders, issue sorts and status combinations, selectors and metadata lookups.
- The local queue validates batches before publishing, wakes idle consumers on send, backs off
  failed or unacknowledged deliveries, and drops with an error log after 10 attempts by default.
  Its fake-clock path uses a short timer to observe externally advanced clocks; it has no DLQ.
- The local blob adapter builds one sorted in-memory UTF-8 key index at startup, so external
  writers require a reopen. New files record a fixed-width size to detect truncation; older files
  without a size field cannot detect body-only truncation. Startup warns and skips corrupt files,
  removes temp files older than one hour, and writes sync the file and containing directory.
- KV counters accept only decimal safe integers, preserve creation TTL, and opportunistically
  sweep expired entries. Stack-helper tests validate complete stacks and inspect the local import
  graph without loading adapter runtime code. Deferred SQL dialect portability is listed under M3.
