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

## 2026-11-21 — M1f ingest compatibility and recovery

- Event timestamps are accepted within 30 days before receipt or one minute afterward; numeric
  strings and millisecond values are supported, and offset-less ISO times are UTC. Unknown field
  values do not poison a valid event. `{{auto}}` user IP is discarded because the app has no
  trusted client-address source.
- Grouping namespaces strategies, uses message templates, and includes chained exceptions in
  order. Titles and culprit/exception metadata are capped at 200 characters. Unidentified later
  event items derive stable IDs from the claim ID and item ordinal for retry idempotence.
- Authenticated event envelopes use a fixed-window error budget; unsupported-only envelopes do
  not consume it. Header DSNs are checked from the first decompressed line before the rest is
  read. Queue publication failure returns 503 and best-effort deletes the raw object; an ambiguous
  publish can thus yield a missing claim, which is acknowledged after five attempts. Overflow
  writes use project/event keys, and existing events are checked before writing duplicate data.
- Removed completion markers; bounded missing-blob retries make late redelivery terminate.
  The erasure suppression predicate is an injectable default-allow hook pending M4.
- Bootstrap handles slug conflicts and uses a new atomic `getOrCreateActiveKey` store operation
  so concurrent bootstrappers converge on one key. Production keys and tokens use WebCrypto;
  token storage uses a SHA-256 hash. The SDK fixtures were captured with @sentry/node 11.15,
  with local user paths replaced by same-length fixture paths; the mixed envelope combines SDK
  event, session and client-report items. Orphan cleanup and raw-deflate support remain deferred.

## 2026-11-21 — Scrubbing SDK capture fixtures

- SDK envelopes include machine context beyond user paths. A checked-in scrubber neutralizes
  machine contexts and local identifiers, rebuilds item byte lengths, and derives the gzip fixture
  from the scrubbed raw envelope. Binary item framing and field types are preserved. A fixture
  test checks current host, user, and repository identifiers as well as the scrubber's output.

## 2026-11-21 — M1d local stack

- The minimal API scopes bearer tokens to their organization and requires `event:read` or
  `event:write`. It supports forward keyset paging, status and sort filters, and reads overflow
  payloads. Non-snapshot cursors remain subject to concurrent sort-key movement. The API rejects
  unsupported filters. When a repeated issue ID is ambiguous within one organization it returns
  409 rather than guessing; the store port now provides an indexed cross-project lookup, and
  SQLite schema version 3 adds the supporting non-unique index.
- The local CLI creates a fresh API token on startup and persists only its hash; it prints the
  token once for that process. Tokens from earlier starts remain valid until token management is
  added. The data directory defaults to ignored `.errtraq/`, the server to `127.0.0.1:8787`,
  and `ERRTRAQ_DATA_DIR` / `ERRTRAQ_PORT` override the local stack. The memory queue and KV are
  process-local and do not survive a restart.
- The standalone runner gives ingest and consumer the same envelope limit and runs optional UTC
  five-field cron jobs. Its deliberately small cron parser supports integers, wildcards, wildcard
  steps and comma lists; unsupported expressions fail at startup. The real-SDK E2E disables the
  SDK deduplication integration to test repeated captures and separately replays an envelope.
  Its temporary data stays under the ignored agent workspace and is removed after the run.

## 2026-11-21 — Hands-on spikes: DuckDB on Lambda, deletion vectors on S3 Tables

Two spikes ran against real AWS; full reports are `.agents-docs/DUCKDB_LAMBDA_SPIKE.md` and
`.agents-docs/S3TABLES_DV_SPIKE.md`. All spike resources were deleted afterwards.

- `@duckdb/node-api` 2.0 works on the nodejs22.x Lambda runtime (arm64 and x86_64) and loads
  `httpfs`, `avro` and `iceberg`. A ZIP with the extensions bundled is unreliable: half the cold
  starts exceeded the 10 s init limit. A container image with the extensions baked in cold
  starts in 1.2 to 2.3 s; installing extensions into `/tmp` at runtime takes 2.1 to 4.1 s.
  `home_directory` must be set or DuckDB fails; an env-based S3 secret avoids loading the `aws`
  extension.
- DuckDB 2.0 against S3 Tables: v3 table creation, appends, a partition-pruned batch-id probe,
  and `DELETE` writing one merged deletion vector per data file all work, and a fresh DuckDB
  process and pyiceberg honor the deletes.
- What does not work: `iceberg_rewrite_data_files` on a v3 table, so the design's `hardErase`
  step has no working implementation on v3 yet; custom snapshot summary properties; and a
  session reading its own commits unless `iceberg_use_metadata_log = false`.
- Athena was not tested (it needs an account-level integration the spike was told not to
  enable) and desk research says it cannot read v3, so it is dropped as a query engine.

## 2026-11-21 — M1g closing review

- Typecheck now maps every workspace export, including adapter and platform subpaths, to source;
  lint checks both the development export and matching source path. A fresh HEAD export with
  the changes overlaid passed install, typecheck, lint and tests before any build.
- Staged envelope keys now retain receipt time and the message idempotency key. Startup requeues
  staged blobs, while shutdown stops acceptance and waits up to five seconds for queues that expose
  idle observation (required by this standalone runner);
  lingering connections are closed and a second signal terminates immediately. Legacy staged keys
  recover with a deterministic fallback ID and a new receipt time if no original time is stored.
- Local tokens live in a mode-0600 file in the ignored data directory, with only hashes in the
  store; restarts reuse the token and `token rotate` revokes it. Tokens issued before the file
  existed cannot be enumerated or revoked through the current port. The local rate limit is 10,000
  event items per minute, configurable or disabled in the standalone configuration.
- API responses expose the available Sentry fields and event interfaces. Unsupported result-set
  filters fail explicitly; pagination remains forward-only and non-snapshot. Request failures log
  a correlation ID and sanitized error details; update conflicts retry three times before 409.
- The opt-in SDK check now uses the SDK's default transport and integrations via a loopback relay.
  It verifies gzip replay, sessions, overflow, paging, authentication, token rotation, persistence,
  accepted-burst drain, staged-blob recovery and bounded shutdown without committing captured data.

## 2026-11-21 — M1 closed

- M1 ran as slices M1a (SQLite store), M1b (queue, blob and KV adapters), M1c (ingest
  pipeline), M1d (API, standalone platform, CLI, e2e), each followed by an independent review
  that reproduced its findings before reporting them, and a fix slice: M1e (for M1a / M1b),
  M1f (for M1c), M1g (for M1d and M1 as a whole).
- Closing verification by the orchestrator on a fresh copy of the tree with a clean install and
  no build: typecheck, lint and 262 tests pass; `pnpm e2e` passes; a manual run with the real
  SDK showed grouped issues, Sentry-shaped event responses (tags as pairs, exception entries
  with frames), 401 without a token, 400 for an unsupported filter, the same dev token and the
  same data after a restart, and a clean exit on SIGTERM.
- Worth knowing when testing by hand: the SDK's default Dedupe integration drops consecutive
  identical errors on the client, so capturing the same exception three times in a row yields
  one event and a `client_report`. Counts above one need distinct call sites or a re-POSTed
  envelope.
- Captured SDK fixtures are scrubbed of machine details by a checked-in script, and a test
  rejects fixtures containing the current host name, user name or repository path. Nothing
  machine-specific may be written to tracked files; the repository is meant to be published.
- Known gaps carried forward are in TODO.md: non-snapshot issue paging, tokens minted before
  M1g cannot be enumerated for revocation, issue `shortId` and `userCount`, the Python SDK
  check, and the dialect-neutrality work for M3.

## 2026-11-21 — M2a infrastructure model

- The runtime and module dependency graphs are validated separately: runtime construction order
  follows explicit named dependencies, while module inputs and existing-value substitutions form
  the Terraform graph. A dependency in one graph does not by itself create a cycle in the other.
- Core retains the existing `ingest` topic name and reserves `archive.project` and
  `notifications`; local routing uses one physical in-memory queue. Reserved topics and the three
  core cron jobs do not imply implemented M4 handlers, so the local stack enables no cron jobs.
- Existing selections replace every declared output, including policies. This conservative rule
  detects future missing outputs early, but requires users to supply outputs not currently used.
  Policy output types and capability names are checked; their actual IAM permissions require
  provider-module review in M2b.
- Function grouping is configuration, not a manifest promise. Standalone intentionally rejects
  splitting or per-function resource settings because it runs one process. Runtime environment,
  generation environment, stack values, Terraform variables and output references have separate
  tags and resolution phases; sensitive variable values must not be emitted to tfvars. The
  current ingest service needs store read access for project-key authentication, so role scoping
  must reflect that dependency rather than assume ingest is store-free.
- Provider module paths use checked-in `infra/modules/<provider>/<component>`; a module version
  field is release metadata, not a Terraform registry version argument. Backend config cannot
  refer to Terraform variables or module outputs. M2b/M2c still own generation and builds.

## 2026-11-21 — M2a2 review: partial validation hardening

- Stack validation must use own-property lookups for user-controlled names: inherited keys such as `constructor` are not declared providers, variables, capabilities or outputs.
- Stack helper import checks now traverse relative imports and reject package imports other than `zod` and `@errtraq/core`, including type-only imports. Dynamic imports remain prohibited.
- The M2a2 model redesign remains unfinished. A preliminary, unintegrated requirements-table draft is in the ignored agent workspace; the existing descriptors and runtime still use the M2a model. Do not begin M2b until all review items and their tests are complete.

## 2026-11-21 — M2a2 validate-once investigation

Adapter config schemas can transform their inputs, so validating an already resolved stack again can reject a valid stack. Construction order is now cached by resolved stack identity and a regression test covers transforming schemas. This is only the first part of A8: the resolved object remains mutable, so the cache assumes callers do not mutate it after resolution; the complete M2a2 model must enforce that invariant before relying on it as a validation boundary.

## 2026-11-21 — M2a2 step 1 references and providers

Infrastructure references use a symbol discriminator so ordinary `kind` fields remain data. Config references allow runtime environment and declared variable references; resolution is deferred until runtime. Region and tags belong to provider entries, with unqualified references using the owning module provider. Resolved stack data is detached and recursively frozen before construction order is cached. Zod schema instances remain shared and unfrozen: freezing a Zod 4 schema prevents lazy method initialization, so the entire reachable object graph is not yet deeply frozen. Adapter schema validation is never repeated on a resolved stack.

## 2026-11-21 — M2a2 step 2 platform contracts

Physical function ids are the split role name or `shared`, ordered by the core role table; settings on shared roles merge only when overlapping values agree. Platforms explicitly declare authorization, binding kinds, reserved names and environment guarantees. Shared in-process adapter state requires both an explicit platform guarantee and one long-lived physical function. Core function limits are broad sanity bounds; each platform must enforce its own tighter limits. The reference tag is `Symbol.for("@errtraq/infra-reference")`: references are in-process values, so the future generator must render them, never JSON-serialize them. Document this and the intentionally unfrozen shared Zod schemas in INFRA_MODEL.md during the planned documentation step.

## 2026-11-21 — M2a2 step 3 core-owned access

Port requirements and topic routes now belong to core; adapters identify resource purposes, supported capabilities, policy outputs and capability-specific bindings without naming roles. The archive feature activates M4 staging and erasure requirements for the queue consumer and cron roles. The archival worker is a queue consumer; cron also needs staging access when erasure resumes an in-flight archive batch. A capability still has one policy output for all purposes, so separate per-resource least-privilege policies remain A2 work. Standalone startup also recovers staged envelopes by listing and re-enqueueing them; it runs in the single local process and does not introduce cloud role grants.

## 2026-11-21 — M2a2 step 4 keyed outputs

Module outputs can be nested maps, and capability policies are selected by both capability and resource purpose. Bring-your-own resources require only reachable output leaves; unused outputs and keys can be omitted. A keyed lookup into an existing map must be statically inspectable so validation can prove the required key exists; an opaque variable for the entire map cannot establish that guarantee. Cron retains primary blob read and delete for erasure as well as its distinct staging policies, as required by the erasure design.

## 2026-11-21 — M2a2 step 5 secret and graph groundwork

Secret bindings carry non-sensitive secret-store identifiers; only explicitly declared sensitive module inputs may contain sensitive variables. Scoped secret-read requirements follow the functions receiving each binding, while SecretSource remains an interface for later platform implementations. Module dependency context is explicit, and the platform depends on derived adapter values and is constructed last. The existing cron table currently contains M4 archive jobs, so those triggers are derived when the archive and cron role are selected; standalone without archive continues without scheduled jobs. The deployment view and lifecycle migration remain open for the rest of step 5.

## 2026-11-21 — M2a2 A12 runtime construction

The CLI constructs adapters in dependency order and closes every returned closeable in reverse order, including after construction failures; the standalone platform closes its server before its dependencies. Queue-only runtime context contains producer routes and event-source to physical-queue to topic mappings. SQLite creates its own parent directory. Standalone owns migration and bootstrap and receives a development-token storage callback; its explicit tokenDirectory replaces the CLI assumption that the token belongs beside the SQLite file. The local stack sets tokenDirectory from the same ERRTRAQ_DATA_DIR reference. A6 remains open.

## 2026-11-21 — M2a2 A6 deployment view

Platform inputs receive the derived functions, scoped bindings and policies, triggers, HTTP roles, and symbol-tagged build artifact references. References inside the view are qualified to their originating selections. Queue trigger settings are keyed by physical queue; when either the consumer timeout or visibility timeout is configured, both are required and visibility must be at least six times the derived consumer timeout. This is a conservative portable model until a future platform declares that its queue has no visibility-timeout concept. Standalone mounts only the HTTP apps selected by its config.

## 2026-11-21 — M2a2 step 6 validation

Nested selection aliases now need a parent manifest childKinds declaration; moduleName exposes the dot-to-underscore address mapping and validation rejects collisions. Terraform literal helpers preserve input data and identify and escape interpolation and directive introducers. JSON-typed values are native objects or arrays; TF_VAR_ is parsed once at runtime, while M2b must use Terraform type any and validate the same container constraint. Iterative preflight bounds nested stack data before Zod recursion. The six-times queue visibility rule now applies only when the queue manifest declares visibilityTimeout support. Step 6 documentation and executable examples remain open.

## 2026-11-21 — M2a2 reference and handoff

INFRA_MODEL.md now describes the implemented model, including the Zod freeze exception, native JSON containers, Terraform literal escaping, capability-dependent queue visibility and the unverified contents of provider policies. Shared and per-topic illustrative AWS stacks compile and validate in the core test suite; the Cloudflare sketch is types only. M2b / M2c follow-ups in TODO.md capture rendering, JSON variable validation, secret-read policies, artifact locations and runtime integration. No generator or cloud adapter was implemented in M2a2.

## 2026-11-21 — M2b AWS descriptor contracts

The AWS descriptors define the HCL module contracts before the modules exist. Both DynamoDB selections use the same module with distinct store and KV purposes. The store promises explicit deletion rather than relying on asynchronous DynamoDB TTL, and does not claim unsupported search capabilities. S3 uses one bucket with a separate `archive-staging/` purpose and policy outputs. SQS uses a 1 MiB encoded-body limit (the M3 producer must account for its envelope), default 180-second visibility and 30-second consumer timeout, and standard queue batch sizes up to 10. Per-topic mode declares three queues, but only topics enabled by core get triggers. Lambda supplies ephemeral writable storage, not a long-lived process or shared in-process state. Actual permissions, cloud behavior and runtime implementations remain M2b / M3 work.

## 2026-11-21 — M2b AWS module contracts

The AWS HCL modules consume the descriptor-derived view and produce keyed JSON policy strings. Core now accepts a policy output typed `string` as well as native `json`; it cannot prove that a string is a policy document, so AWS module mock tests verify the intended scopes. Terraform validates isolated copies with its plugin cache under the ignored workspace, and mock-provider tests exercise the resources without cloud access. The current AWS provider emits deprecation warnings for DynamoDB `hash_key` / `range_key`; those attributes retain compatibility across the declared 6.x provider range.

Lambda function URLs use public `NONE` authorization for ordinary Sentry clients and depend on errtraq's application authentication. Secret bindings are Secrets Manager ARNs; customer-managed keys need separate KMS authorization. The module accepts the UTC cron form currently emitted by core, with wildcard weekday, and passes `{ "job": name }` to the future entrypoint. S3 versioning is disabled for object erasure; envelope and staging expiry must exceed operational recovery windows. DynamoDB GSIs are eventually consistent and require M3 to maintain sparse lookup items and their index keys as documented in the AWS module README. PITR backups need an operational erasure policy.

## 2026-11-21 — Second infra review, part 1

IAM policies use the distinct `json-document` output type: literal existing values must be valid
JSON text and AWS module policy leaves remain serialized strings. JSON stack variables instead
enter Terraform as strings and require `jsondecode` plus object / array validation at generated
uses. Terraform JSON templates also evaluate object keys, so infrastructure keys are restricted
and generators must escape both keys and values. HCL has no output type declarations: output
descriptions declare contract types and key patterns for the default descriptor check, while
mock-provider tests verify actual AWS output shapes.

Resolved stack copies retain a marker and are rejected with a clear error instead of re-running
transforming schemas. Provider aliases are selection-specific and AWS regions are checked by
provider source. Backend settings are allowlisted non-secret scalar metadata for S3 and local;
credentials come from the backend environment. Function ids already used stable split-role and
`shared` names; tests now cover split changes. Notifications are inactive unless explicitly
enabled, and SQS provisions only queues present in the derived active triggers. N5-N7 and the
remaining documentation review are the next slice; later review items remain in TODO.

## 2026-11-21 — Second infra review, part 2

Child bindings follow the functions requiring their root port; child policies follow matching
parent capabilities, and child resources, policies or capability-filtered bindings that cannot
be delivered are rejected. Child secrets retain their own scoped secret-read requirements.
Function platforms with environment bindings receive an additional queue event-source binding
per physical trigger. The deployed construction API is exported from core for generated static
entrypoints: it constructs only required selections and dependencies, consumes binding values
by name, and closes in reverse order. The local construction path is unchanged. Platforms must
declare supported config reference kinds; Lambda rejects both runtime environment and variable
config references until it implements their delivery, while standalone supports both.

The build artifact manifest now has an explicit path, handler, runtime and content hash shape;
the Lambda module currently consumes the path and calculates the hash itself. Stack variables
support literal non-sensitive defaults, which the future generator can emit in tfvars; JSON
defaults must be encoded as text. Existing queue settings remain an operator promise, not an
inspection of external resources. The root test workspace now directly declares the already-used
Zod version for AWS config-reference tests; no new runtime dependency was introduced.

## 2026-11-21 — M2b AWS HCL review fixes

Provider 6.28 introduced Lambda URL invoke permission support, and 6.29 introduced DynamoDB
GSI `key_schema`, but 6.29 crashes validating this module's dynamic GSIs. The practical minimum
is 6.30; the opt-in module gate pins 6.30.0 and 6.73.0 and fails deprecation warnings. DynamoDB
uses `key_schema` and a delete-only IAM action rather than BatchWriteItem. Stack protection
defaults to production and must explicitly be disposable to permit table and bucket teardown.

Blob read includes prefix-scoped list access. A deployed cron role has the read / list / queue
produce requirements for staged-envelope recovery; its scheduler and handler remain M3 work.
The S3 adapter must distinguish 403 from absence with an authorized prefix probe rather than
mapping 403 to missing. Overflow objects cannot use a fixed expiry without violating per-project
retention. Lambda URL authorization is per function; ingest CORS at the URL needs coordination
with app CORS in the future Lambda handler. External EventBridge DLQs need a resource policy.
The current per-topic stack's sampled largest inline-policy total is about 2440 characters with
logging and no secrets; a Terraform precondition enforces the actual 10240-character limit.
Section B is recorded in TODO; review item 10 remains the next slice.

## 2026-11-21 — M2b HCL contract and mutation checks

Terraform module tests now compare exact capability policies and security-relevant resource
settings, including role-specific attachment, environment, trust, GSI schemas and protection.
The default TypeScript test checks descriptor output types and reference paths against a committed
snapshot; the opt-in gate captures real mock-provider output values and compares their shapes
at both pinned AWS provider versions. Output descriptions are no longer treated as type proof.

The mutation catalog contains the 20 distinct mutations actually listed in the review (the prose
says 21). All were detected: Terraform tests caught 19, the live output-shape check caught the
DynamoDB name type change, and both caught the SQS queue output shape change. The mutation runner
first checks unmodified baselines and uses isolated temporary copies. Provider initialization uses
`-plugin-dir` against the cached filesystem mirror when the exact platform binary exists, with
Terraform's cache environment variable removed to avoid installing the mirror into itself. A
run with unreachable HTTP proxies verified that cached provider versions do not need registry
access. Initial cache misses still download the pinned version through the normal registry path.

## 2026-11-21 — M2b Terraform JSON generator

The generator is pure: callers supply both directory locations, generation-time values and
per-function relative artifact paths. Standalone returns an explicit not-applicable result.
Terraform JSON provider aliases and module metadata are emitted as literal references, while
ordinary strings and keys are escaped as Terraform templates; JSON variables remain strings
and decode at their use sites. Non-sensitive defaults are also emitted in tfvars. The shared
and per-topic AWS file sets are snapshotted; generating and validating Terraform roots belongs
to the next slice. A separate edge-case probe found that core parsing silently drops an own
`__proto__` variable key, which is recorded in TODO for a model fix.

## 2026-11-21 — M2b generated Terraform roots

Terraform rejects an empty JSON block for a labeled block type, so the generator omits empty
variable and output blocks. The opt-in infra gate now tests generated roots with mock AWS
providers at both pinned versions. A test-only output file in an isolated copy of the Lambda
module exposes actual resources for comparison with expectations computed from the deployment
view; the archive fixture makes the cron checks non-vacuous. Generated-root mutations exercise
policy assignment, bindings, triggers and escaping. The stack parser rejects an own `__proto__`
variable key before Zod can silently discard it.
The sensitive-variable fixture marks its test-only handler input sensitive and supplies a canary
through `TF_VAR_SECRET`; the JSON fixture uses a decoded variable for module tags.

## 2026-11-21 — M2c build and CLI

Deployed construction now derives a compact plan before bundling, so a Lambda entrypoint imports
only the runtime adapters its roles require while preserving binding and queue-source scopes.
The Lambda handler factory lives at the `./handler` subpath to keep the adapter's root export
triple intact. The current consumer does not use KV, so its unused KV option is optional; AWS
cron job implementations and runtime adapters still belong to M3 / M4. The build emits ZIPs
with `index.mjs`, per-function manifests and a stack manifest; generation verifies their hashes
and uses relative ZIP paths. A standalone bundle statically imports its adapters and passes the
SDK e2e. Generated Terraform output ownership is recorded in a marker, and unowned files and
symlink escapes are rejected. esbuild 0.28.2 was already in the lockfile and its install script
was already allowed; fflate 0.8.2 supplies local ZIP creation without a system utility.

## 2026-11-21 — M2 closed: standalone container

The standalone build now writes a Node 22 Dockerfile that runs as the image's non-root user,
stores data in `/data`, checks `/health`, and explicitly opts into `ERRTRAQ_HOST=0.0.0.0`; the
local stack defaults to loopback. Docker PID 1 ignores the default disposition of a second
SIGTERM, so the generated server explicitly exits on a repeated signal in that case. The full
SDK e2e passed against the image with a random host port, including crash recovery, token rotation
and bounded shutdown. The image's default user and unflagged `node:sqlite` were checked directly.
The sandbox blocked Docker's normal buildx state writes, so that run used an isolated Docker
client configuration and the legacy builder; ordinary Docker configuration remains supported.
CLI output and build metadata now use repository-relative paths, with regression checks over
Terraform, manifests, bundle contents and ZIP entries. AWS runtime adapters, deployed secret
sources and real AWS deployment remain M3 work.

## 2026-11-21 — M2d review fixes, part 1

Free-text path hygiene now detects complete multi-component repository and home prefixes rather
than arbitrary substrings; single-component roots such as `/app` and `/root` are intentionally
ignored, while esbuild metadata is separately checked for absolute input paths. A copied
`src/app` checkout exercises the standalone build and Sentry fixture checks. Generated roots
preserve Terraform-owned working files and reject markers for another stack. Temporary-directory
creation was fixed in tests and the mutation script. Node 22.18.0 is now the declared tooling
minimum, checked by the CLI before loading a stack. The first clean export passed typecheck,
lint and all tests before any build; M2d items 5-8 and the full final gate remain next.

## 2026-11-21 — M2d Node release range clarification

The supported tooling range is `^22.18.0 || >=23.6.0`: Node 23.0 through 23.5 predate default
TypeScript stripping even though they are newer than 22.18. Package engines, documentation and
the CLI's preflight use the same range.

## 2026-11-21 — M2d completed: M2 review closed

Builds remove only stale function directories owned by the previous manifest, and report foreign
paths rather than overwriting them. Lambda initialization is shared across concurrent invocations
but resets after failure; generated entries now use the core cron registry, acknowledging unknown
or missing names and logging M4 placeholders as unimplemented. Platform manifests can declare a
stack-name limit, deployed bindings reject empty values, and consumer and HTTP failures share
credential-pattern redaction. Ingest CORS is limited to ingest routes. Standalone DSNs use an
optional public origin or localhost for wildcard listeners; build output names the bundle and
Dockerfile. The Node container base is pinned to the 22.23 minor, with bump instructions in the
README. M2's final review is closed: the fresh-export gate passed before build, both e2e modes,
mock Terraform validation and mutation checks passed, and the container e2e passed with an
isolated Docker client configuration. AWS runtime adapters, deployed secrets and real cloud
deployment remain M3 work; cron implementations remain M4 work.
The source e2e passed with a recurring `Skipping unreadable blob` / `ENOENT` log in one run;
the existing M3 recovery-race investigation remains open and no cause is assumed.

## 2026-11-21 — M2 closed (orchestrator notes)

- M2 ran as: M2a (infra model design), a first peer review that built a prototype generator on
  it and found it insufficient, M2a2 (model revision in six steps), a second peer review
  (prototype with no casts, eight variants through `terraform validate`, no blockers), model
  fixes in two parts, M2b (AWS descriptors, HCL modules, generator, generated-root validation),
  a peer review of the HCL modules (mock providers only) and its fixes, M2c (CLI, build,
  container), a closing peer review, and M2d (its fixes).
- Closing verification by the orchestrator: on a fresh copy placed under a directory named
  `src/app`, with a clean install and no build, typecheck, lint and 402 tests pass; the three
  example stacks build; `infra generate` works and regenerates with Terraform working files
  present. In the working tree `pnpm e2e`, `pnpm e2e --bundle`, `pnpm infra:validate` (8
  generated-root variants at both pinned provider versions), `pnpm infra:mutate` (20 module and
  5 generated-root mutations detected) and `pnpm container:check` pass. The M2d fixes were
  verified this way, not by a further independent review.
- Process lessons. A large redesign handed to the implementing agent as one task was abandoned
  twice (once per conversation) with "incomplete, no blocker"; the same work succeeded as
  normal-sized steps with a review between each. Tests written by the implementer looked
  thorough and caught 6 of about 20 seeded faults until a mutation check was required; require
  mutation checks for security-relevant contracts from the start. Reviews that build a
  throwaway consumer of an interface (a prototype generator) found far more than reading did.
- Operational note: running `terraform init` by hand with `TF_PLUGIN_CACHE_DIR` pointed at the
  shared plugin cache overwrote a cached provider binary and left it unloadable; use the
  scripts, or a private cache directory, for manual experiments.
- What M2 does not prove: nothing has been planned or applied against a real AWS account, the
  AWS runtime adapters are stubs, and deployed secret resolution is an interface only. M3
  starts there.

## 2026-11-21 — M3a AWS emulator harness

- Winterbaume server release 0.2.6 ignores S3 Range; a separately signed AWS CLI request
  reproduced the full-object response. Source revision `69fed1d7fb0eb9a2738ff3274197c7591129c4cb`
  passes the ranged-read probe, so the harness verifies that archive's SHA-256 and builds
  the pinned source in the ignored workspace. Building the full server is expensive in
  time and disk. No tested DynamoDB or SQS gap justifies an additional emulator yet.
- The probes and their precise scope are in `M3_EMULATOR_SUPPORT.md`. They exercise local
  behavior, not SigV4, IAM enforcement, production security settings, or full AWS parity.
  The test client refuses non-loopback endpoints and uses dummy request authorization.
- The harness derives the table and queue shape from the Terraform modules and checks
  namespace cleanup. Basic Terraform control-plane create/read/delete probes pass, but they
  do not prove a generated root applies; M3a2 will exercise the provider's full workflow.
