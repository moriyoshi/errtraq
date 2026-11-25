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

## 2026-11-21 — M3a2 real-provider support probe

The AWS provider can create the DynamoDB, SQS and Lambda module fixtures against pinned
Winterbaume with both tested provider versions. The S3 lifecycle waiter and generated root
hit the bounded apply timeout because lifecycle minimum-object-size metadata is not returned.
More seriously, table deletion protection is discarded, and several Lambda permissions,
partial-batch and EventBridge retry settings disappear on API readback. Invoke returns a
fixed response without executing the ZIP. The precise requests, observed responses and
limitations are recorded in `WINTERBAUME_GAPS.md`; mocks still test the module contracts.
The complete API-asserting generated-root apply workflow remains the next M3a2 turn.

## 2026-11-21 — M3a2 local provider integration

The local real-provider workflow now checks standalone modules, both generated stacks,
API-visible function policies and bindings, change plans and destruction. The actual AWS
examples activate only the ingest topic; a feature-enabled archive/notifications fixture
checks the three-topic transition. Exceptions have named data entries, live probes and
visible output: S3 lifecycle and ownership-control resources are excluded in temporary
module overrides, and known response omissions are isolated in the repeat-plan check.
Winterbaume also fails to delete S3 ownership controls and loses default-tag readback for
several resources. Provider 6.30.0 independently plans GSI churn because its diff code lacks
the range-key suppression present in 6.73.0; the user approved using 6.73.0 for this
integration while the existing validation gate continues to cover both provider versions.

## 2026-11-21 — M3b S3 runtime and provider minimum

- AWS provider 6.32.0 lacks the GSI `range_key` diff suppression; 6.32.1 adds it in
  hashicorp/terraform-provider-aws PR 46442, also recorded in that release's changelog.
  The declared AWS minimum and the lower infra-validation pin are 6.32.1; 6.73.0 remains
  the latest-tested pin. A local emulator apply with 6.32.1 and the module/root validation
  gate passed.
- The S3 adapter signs Web fetch requests with aws4fetch and parses bounded S3 XML responses
  with fast-xml-parser. Stream uploads use replayable 5 MiB multipart chunks; credentials
  are looked up per request. For a 403 read, exact-prefix listing distinguishes a missing
  object from an actual denial. Web URL parsing normalizes `.` and `..` segments, so the
  adapter explicitly rejects those keys and empty keys instead of addressing another object.
- The pinned unmodified Winterbaume S3 decoder corrupts percent-encoded UTF-8 bytes. The
  original probe now detects this specific gap, while the S3 contract uses a separate
  checksum-verified local decoder patch approved for this slice. The upstream decoder gap
  remains to be filed and the patch removed after an upstream fix. The seven opt-in S3
  contract and stream tests pass against the patched server; no real AWS deployment or
  signature-enforcing emulator has yet been exercised.
- Construction now passes the host environment through the adapter context, so S3 can
  refresh standard Lambda credentials without using Node globals in Workers-compatible code.

## 2026-11-21 — M3c SQS runtime

- S3 and SQS share the WebCrypto-based aws4fetch signer in the internal `aws-signing`
  package. SQS signs JSON API requests using refreshable Lambda environment credentials.
- Producers validate all entries before sending, count the UTF-8 envelope against the SQS
  1 MiB limits, split at 10 entries or 1 MiB, and retry only transient failed entries.
  Producer delay uses SQS integer seconds (0 through 900). A thrown batch request can have
  been accepted before a network failure, so callers must tolerate duplicate messages.
- Lambda consumes only ARN-mapped topics and returns partial failures; delayed retries use
  ChangeMessageVisibility and fall back to the original visibility timeout if it fails.
  Consumer queue URLs derive from the delivered ARN and region, avoiding additional bindings
  or GetQueueUrl permission. Retry visibility is bounded to integer seconds up to 43200.
- The unmodified Winterbaume push driver runs the queue contract in shared and per-topic
  modes with polling, visibility and partial acknowledgements. It does not enforce real AWS
  IAM or execute Lambda; deployed event-source behavior still needs M3h.

## 2026-11-21 — M3b2 S3 review, items 1 to 5

- Worker global fetch requires the global receiver; S3 and SQS bind injected or ambient fetch,
  and the opt-in Miniflare / workerd smoke test executes both bundles against loopback fakes.
  Miniflare 4.20260730.0 is pinned for this test; its workerd postinstall is allowed explicitly.
- The BlobStore contract now rejects empty keys, keys over 1,024 UTF-8 bytes, control
  characters and dot path segments in S3, filesystem and memory implementations. The rule avoids
  Web URL normalization ambiguity. S3 errors preserve provider codes and distinguish missing
  buckets when S3 supplies the code. A body-less HEAD 404 remains ambiguous and is treated as a
  missing object, because probing the bucket can require additional permissions.
- Streaming reads forward cancellation to the underlying reader. Small streams use a single
  PUT; multipart starts only beyond one full 5 MiB part. The S3 write policy now includes
  prefix-scoped AbortMultipartUpload, tested by the Terraform contract and a mutation. A failed
  upload and failed abort both surface in an AggregateError; lifecycle is the backstop.
- Review items 6 to 10 remain for the next turn. The 403-versus-missing behavior, multipart
  authorization, payload mode and URL-encoded plus behavior still require real AWS verification.

## 2026-11-21 — M3b2 S3 review, items 6 to 10

- S3 requests use a 10-second header timeout and 30-second body idle timeout by default,
  configurable per stack. Bounded retries use full jitter with a 500 ms base and respect
  Retry-After. One ExpiredToken response triggers a fresh credential lookup and retry.
- In-memory request bodies carry signed x-amz-content-sha256 hashes; multipart buffering
  remains bounded. URL-encoded list keys decode form-style plus as space, while %2B is plus.
- AWS S3 and SQS stack helpers point at runtime-only package subpaths. A small core blob
  subpath avoids pulling the Zod-bearing stack barrel into S3 runtime bundles. Dedicated
  esbuild metafile tests guard both adapters; whole Lambda bundles may still contain Zod
  from unrelated core or handler imports.
- Delivered blob bindings define primary and staging access in code. List prefixes and keys
  must stay within those purposes, and the staging prefix binding is required and checked.
  The staged-envelope recovery job already lists the permitted envelopes/ prefix.

## 2026-11-21 — M3d DynamoDB KV runtime

- KV stores the original string, a numeric counter for decimal safe integers, a mode marker,
  and a revision. Strongly consistent GetItem and conditional UpdateItem protect strict
  integer and overflow semantics; UpdateItem uses atomic ADD and returns its new counter.
  TTL is stored in exact milliseconds plus the module's `expiresAt` seconds attribute,
  preserving the original expiry on increments and treating an expired row as absent.
- KV write policy now includes table-scoped GetItem: a write-only role must be able to run
  increment's validation read. KV uses only GetItem, PutItem, UpdateItem and DeleteItem.
  A retried increment whose successful response may have been lost uses its revision to
  recognize success; if another write obscures the result it reports an ambiguous outcome
  instead of applying the increment again.
- Winterbaume's UpdateItem handler checks conditions separately from the backend update.
  The native ADD result lets the 50-way contract pass, but conditional-update races,
  expiry resets and safe-integer boundaries need real DynamoDB verification. The injected
  future clock demonstrates logical TTL expiration while the physical item remains.

## 2026-11-21 — M3c2 shared AWS requests

- `aws-signing` now owns the signed HTTP request path used by S3, SQS and DynamoDB KV. It
  provides 10-second per-attempt and 25-second overall defaults, abort, full-jitter retries,
  Retry-After and one refreshed-credentials retry for ExpiredToken. Service error codes
  from JSON and S3 XML become typed request errors; S3 and KV retain their port-specific
  errors. Runtime schemas can override both request and overall budgets.
- S3 continues streaming response bodies with an idle timeout and hashes in-memory payloads.
  KV preserves its ambiguous-update safeguards when a retried conditional update fails.
  The AWS IAM ListUsers and AWS signing-suite get-vanilla vectors are asserted centrally.
- This turn covers review item 1; items 2 through 8 remain for the next turn. SQS FIFO is
  unsupported and real AWS behavior / scrubbed event fixtures remain M3h follow-ups.

## 2026-11-21 — M3c2 SQS review, items 2 to 8

- Visibility changes run with concurrency four and share the invocation deadline; invalid
  finite delays are clamped, non-finite delays dropped, and both are logged. Poison records,
  delay changes and failed visibility requests log IDs and safe reasons only. Duplicate IDs
  are handled once; Lambda construction passes the same core logger to adapters and services.
- Queue bodies are validated as plain JSON across SQS, local memory and testing fakes before
  publishing; SQS escapes U+FFFE and U+FFFF on the wire. Lambda queue DLQs require at least
  the consumer's five missing-claim attempts. Construction fails if an active topic lacks an
  implemented consumer, instead of starting a retry loop.
- Packages declare Workers runtime entries in their manifests. The layering check traverses
  workspace value imports from those entries, excluding type-only edges and tests; the future
  DynamoDB store stub now has a separate runtime entry. Workerd smoke exercises delayed SQS
  push retry as well as production. The emulator driver uses full receive attributes and tests
  handler and entry failures, redelivery attempts and DLQ redrive in both queue modes.

## 2026-11-21 — M3e DynamoDB design for review

The proposed single-table design uses 16-way event partitions and transactional base-table
lookup items rather than eventually consistent GSIs, preserving immediate event discovery at
the cost of extra writes, reads and issue-level contention. The design flags three decisions
that need review before implementation: a bound or new atomic protocol for bundle debug IDs,
durable erasure receipts across a commit/response crash, and the broader `DeleteItem` permission
needed for mutable lookup rows. The current 200,000-byte payload overflow threshold does not
bound the complete DynamoDB item. The emulator's conditional-write race cannot establish CAS or
transaction concurrency correctness; the proposed upstream pin bump needs separate gap checks.

## 2026-11-21 — M3f Postgres SQL store

The SQL store now runs against Postgres with byte-wise `C` collation and bigint decoding,
transaction-scoped advisory locks and a small reusable `pg` pool. Record insertion takes the
issue lock before the event write, so concurrent issue updates do not lose bumps; same-project
initial key creation and schema migration have separate locks. Server-side statement and idle
transaction timeouts let Postgres cancel work before a connection is returned to the pool.
Postgres correlation statistics on event issue and bundle scope are necessary for the tested
large-table distributions to choose ordered index paths under default planner settings. The
planner can still choose other plans with different statistics or settings. The 255-character
indexed key boundary needs a deliberate port-level treatment. Standalone secret identifiers
resolve through the supplied environment; deployed secret resolution remains M3g.

## 2026-11-21 — M3e revised DynamoDB and subject-index design

The owner-selected design now uses sparse, eventually consistent GSIs with strong hydration,
per-event or grouped issue updates, an opt-in hot-issue limit, and asynchronous reduced-subject
indexing. Terraform provider 6.32.1 validated a numeric multi-attribute GSI key schema locally;
that does not prove the AWS API or emulator behavior. Two proposed erasure guarantees remain
review blockers: an eventual issue-index count cannot prove completeness or include archived
history, and a separately closed admission epoch cannot fence a stale two-action event
transaction without additional coordination. The companion design recommends a conditional
fence action when erasure is enabled and calls out its conflict with the requested two-action
shape. The new PII and lifecycle contracts also need cross-adapter review before coding.

## 2026-11-21 — M3f2 RDS IAM authentication, part 1

RDS passwords are SigV4 presigned `rds-db` connect URLs; the independently computed HMAC
vector was cross-checked against an offline AWS CLI token using dummy session credentials.
The Postgres pool signs on each new connection with the current environment credentials and
uses hostname-verified TLS. For Lambda ZIPs its default CA file is `/var/runtime/ca-cert.pem`;
other runtimes must provide a maintained PEM path, including ACM/ATS roots for RDS Proxy.
IAM selection requires a platform that guarantees AWS credentials. The policy module and VPC
wiring remain the second part, so the new IAM descriptor is not yet deployable.

## 2026-11-21 — M3f2 RDS IAM policy and Lambda VPC

The RDS IAM access module grants `rds-db:connect` only to the configured resource ID and one
PostgreSQL user in the provider's account. Read, write and delete share that identity: IAM
controls connection while PostgreSQL privileges determine operations, and validation reports
this scope. Lambda VPC placement applies to every physical function, with the AWS-required EC2
network-interface actions on `*` and an explicit paired-subnet/security-group precondition.
Infrastructure-only platform variable references are declared separately from runtime config
references, so VPC input support does not silently enable undelivered adapter config variables.
The pinned Winterbaume accepts but drops `VpcConfig` on Lambda create/readback; the emulated
Postgres fixture reprobes this before excluding the block in its temporary module copy. Real
networking, IAM authentication, token expiry and the Lambda CA bundle remain M3h checks.

## 2026-11-21 — M3e final design revision

The owner chose an inline, separate Parquet-in-blob subject index and all-time issue counts;
DynamoDB stores no subject-index items. The implementation plan is staged so the per-event
store and bundle lifecycle can proceed without the later batch, rate-limit or erasure work.
A strong issue pointer avoids an eventual-index false 404. Exact composite count ordering
requires a conditional count preimage, which the peer's 500-writer DynamoDB Local experiment
did not exercise; measure that added contention. A visibility wait, two empty index passes
and an empty DLQ cannot prove a committed but unindexed event is absent from the main queue.
Stage 4 must resolve that completion guarantee or explicitly narrow it before claiming erasure.
Manifest CAS also needs an atomic lease-fencing check: a version check alone does not fence a
stale holder after lease takeover.

## 2026-11-21 — M3e stage 1 shared contracts

Subject deletion and the old count-decrementing repair path now fail explicitly until M4.
Event paging carries a source-local examined-key cursor independently of the federation
boundary, so the API can return an empty page with a continuation. SQL migration 4 preserves
legacy bundle lookups and rejects duplicate debug-ID ownership rather than silently choosing
an owner. Bundle manifests use a canonical SHA-256 digest; marker chunks are capped at 100
and validated against the immutable manifest. Pending cleanup uses a durable claim and progress
marker before deleting its unique, never-reused manifest key, so blob-delete failures can be
retried. The cleanup helper still needs scheduling and the unimplemented bundle API needs its
separate metadata-delete and blob policies; their requirement rows are recorded but inactive.
The SQL activation and cleanup API supplies the full manifest ID list, since a store adapter
does not itself have a BlobStore dependency. The DynamoDB implementation must preserve bounded
marker operations and the TTL-clearing crash caveat in the design.

## 2026-11-21 — M3e stage 1 table infrastructure and emulator

The redesigned table is versioned as `<stack>-store-v2`; applying the new module to a
previous table is a migration, not an in-place reinterpretation of old index keys. The
project-time shard count is persisted as a table item and guarded against changes in both
Terraform state and readback. Production metadata uses `prevent_destroy` so a failed table
destroy cannot erase the shard count first; changing production to disposable therefore
requires an explicit state migration. Metadata DeleteItem has a separate LeadingKeys
policy with a missing-key guard; event deletion uses BatchWriteItem scoped to `EV|` keys,
which can also put event items and is restricted to event-deleting roles.

Winterbaume main `79c452d2bb2844abf771cfa4a497275c24b46489` retains keys-only GSI
projections and fixes lifecycle-header, deletion-protection, SSE, EventBridge retry/DLQ,
and Lambda partial-batch readback. Its S3 UTF-8 bug still requires the unchanged verified
local patch. Conditional-update issue #61 still reproduces: four of 200 requests passed
the same absent-item condition. Lambda VPC readback issue #62 and the recorded tag and
ownership-control exceptions remain. These local readbacks do not establish real IAM
enforcement, DynamoDB transaction isolation, actual at-rest encryption or Lambda execution.

## 2026-11-21 — DynamoDB stage 1 step C in progress

The runtime skeleton uses the shared AWS request layer and a runtime-only core store entry.
Project, release metadata, and meta operations use framed keys, sparse indexes with strong
hydration, and conditional transactions; the relevant existing shared contract cases pass
against winterbaume. The examined-key cursor advances through stale index entries without
skipping a live entry. Workers smoke exercises the store without importing stack schemas.

Bundle lifecycle is not implemented yet. The accepted port's `deleteBundle(projectId, id)`
provides no manifest IDs, and the store has no BlobStore dependency. An eventually consistent
GSI cannot establish that all ownership markers have been removed. A decision is pending on
persisting bounded manifest chunks in the table, extending the port, or introducing a blob
dependency. The issue, event and recordEvent operations remain the explicitly requested
future-step stubs.

## 2026-11-21 — DynamoDB bundle lifecycle

Bundle marker writes now record bounded chunks in the bundle's base-table partition in
the same transaction as their ownership markers. Cleanup and active deletion enumerate
these chunks with strongly consistent, bounded queries. A generation fence on bundle and
marker items prevents an interrupted deletion or lookup from treating a later reuse of the
same bundle ID as the original. Marker TTLs are cleared in conditional batches before
activation; the previously documented interruption caveat still applies.

The unchanged shared contract's 1,001-ID lifecycle and blob-cleanup retry cases pass on
winterbaume, as does a separate interrupted active-deletion test. Winterbaume issue #61
means these tests do not establish real conditional-write atomicity; verify concurrency
on a faithful DynamoDB service as already planned for M3h. Query and BatchGetItem need
store read, PutItem and UpdateItem need write, and marker/chunk deletion needs the
separate metadata-delete capability.

## 2026-11-21 — DynamoDB stage 1 step D in progress

Implemented the per-event issue/count transaction, the strong issue-ID pointer and sparse
issue lists. A deterministic fake HTTP transport covers a condition failure with a returned
issue image and a duplicate event without relying on emulator timing. Transaction cancellation
images are deliberately non-enumerable because they can contain user data.

The pinned winterbaume's issue #61 is a concrete blocker for the unchanged 40-concurrent
shared contract: it produced a numeric count of 2 alongside a serialized issue count of 1,
so the count preimage guard correctly exhausted its bounded retries. One diagnostic measured
2,510 attempts for 40 events, with 9 fulfilled and 31 failed; this is not an AWS contention
measurement. The opt-in emulator command runs the diagnostic and explicitly names the skipped
shared 40-concurrent assertion. A faithful DynamoDB implementation is needed to verify it;
this environment has no Java runtime for DynamoDB Local. Step D remains unverified.

## 2026-11-21 — DynamoDB conditional-write fallback

The earlier Java limitation was resolved without installing tools: a cached, digest-pinned
DynamoDB Local Docker image runs the unchanged shared 40-writer, concurrent issue-update,
and duplicate-delivery cases. The 40-writer case passed with 439 transactions for 40 events
(10.97 attempts/event) in this run. This is local-emulator contention, not an AWS prediction.
The opt-in AWS emulator command uses the cached image only and prints a skip if it or Docker
is unavailable; winterbaume's issue #61 diagnostic remains separate and visibly non-authoritative.

Winterbaume also admitted both writers in the existing concurrent metadata CAS case under
load. The harness therefore runs the unchanged CAS and active-key concurrency cases on the
same DynamoDB Local fallback as the issue transactions, while retaining the winterbaume
gap probe. This prevents a known emulator race from making the opt-in gate flaky.

## 2026-11-21 — DynamoDB stage 1 events and narrow issue guards

Mutable issue fields are now separate attributes, so count-only occurrences do not rewrite
serialized issue data or status index partitions. Count guards protect the exact count sort
key; the guarded regression predicate prevents a concurrent status change from being lost.
Legacy items without the separate fields upgrade on first write using the old preimage guard.
The 40-writer DynamoDB Local contract measured 394 attempts / 40 events (9.85 per event),
versus 433 / 40 (10.82) in the prior run. These single local measurements are noisy; the
mandatory count preimage remains a contention point and real AWS measurement remains M3h.

Event reads use the issue-time index or merge project-time shard streams, strongly hydrate
candidates, and preserve both per-stream examined keys and the global examined boundary in
the cursor. The global boundary prevents an earlier insertion in an unconsumed shard from
appearing on a later page. Deletes use bounded BatchWriteItem retries. The entire shared
store contract ran across winterbaume and DynamoDB Local; only concurrent cases move to
Local because winterbaume issue #61 invalidates their atomicity assertions. A transient
SQS redrive probe failed once; the final full emulator rerun passed.

## 2026-11-21 — M3g Lambda secrets and config delivery

Lambda entrypoints now keep one Secrets Manager source per execution environment. It signs
GetSecretValue using the ARN's region and current Lambda credentials, coalesces concurrent
reads and caches values for five minutes. Only full secret ARNs are accepted; errors omit
provider messages and identifiers. The existing Lambda module already derives an exact-ARN
GetSecretValue policy per receiving function. Customer-managed KMS keys need separate decrypt
authorization. Postgres secret mode explicitly declares authorization via its scoped secret
binding; validation rejects a capability lacking both an IAM policy and a matching binding.

Runtime config references are delivered through namespaced bindings for the functions that
construct each selection. `env("NAME")` becomes a Terraform string variable
`errtraq_env_NAME`; stack variables retain their types, with JSON / lists encoded as text.
Sensitive variables are still rejected from config. The generated-root checks include all
variable types, Postgres secret mode, and per-function secret-read policy resources. Bootstrap
and deployed staged-envelope recovery remain for the next M3g turn.

## 2026-11-21 — DynamoDB deployment blockers and bootstrap

Multi-shard event cursors retain each started stream's original key range; the global
examined boundary narrows only streams without a start key. The shared contract now pages
project-wide listings and archival scans across four shards, including DynamoDB Local where
invalid range/start combinations are rejected. DynamoDB schema metadata is loaded lazily,
with one shared in-flight strong read and retry after failure. The API metadata-delete grant
is active and generated roots assert its exact derived policy. Bundle cleanup's separate role
remains future work.

Deployed bootstrap runs from the operator's CLI, avoiding a new public endpoint or a Lambda
role with secret-creation authority. Store migrations run first (Postgres uses its existing
advisory migration lock; DynamoDB verifies provisioned schema metadata). Secrets Manager
CreateSecret provides the atomic create-or-read handoff: the winner's secret contains the DSN
and first API token, and retry registers that same token if interrupted. The CLI prints only
the secret ARN; neither credential is a Terraform input, output or log value. New insert-only
`ProjectRepo.createToken` semantics prevent retries or concurrent bootstrap from reviving a
revoked token. Postgres separate-pool and DynamoDB Local store-plus-KV tests exercise concurrent
bootstrap; Secrets Manager requests use fake HTTP in tests, so actual IAM, AWS consistency and
network access remain M3h checks. The command needs operator-provided non-secret binding values
and AWS credentials; it currently supports independent top-level store and KV selections.

## 2026-11-21 — DynamoDB review: buffered listings and bundle recovery decision

Issue and event GSI merges now prefetch bounded batches, strongly hydrate at most 100 distinct
base keys per request, and retain only examined positions in cursors. Bundle release and pending
expiry listings use distinct sparse index partitions; existing bundle rows need a backfill.
Conditional metadata writes use a single PutItem, and bundle cleanup uses a conditional
DeleteItem. Bundle transactions classify cancellation reasons and retry conflicts; contending
record-event transactions now use full jitter capped at 500 ms.

On DynamoDB Local, an isolated same-issue, same-timestamp stress run recorded 23.18 transaction
attempts per event and zero failures at 200 writers; 500 writers recorded 58.55 attempts per
submitted event and 213 of 500 operations hit the 80-attempt contention limit. The cap alone
therefore does not solve hot-issue contention; real AWS measurement and the retry/admission
policy remain open. The stress runner confirmed the stored count equaled successful operations.

The requested TTL backstop on pending bundle metadata and manifest chunks conflicts with
ARCHITECTURE.md's resumable interrupted-cleanup guarantee: after an arbitrarily long outage,
the TTL sweeper can remove the only recovery record. No such TTL was added while the owner
chooses a bounded guarantee or an additional durable recovery record. The existing marker TTL
and its already-documented crash-reclamation limitation remain. M3g staged recovery cron was
not started in this turn.
The stress harness counted all rejected operations together; an earlier run showed the first
rejection was the retryable contention-limit error, but it did not classify every rejection.

## 2026-11-21 — Issue-keyed recording design

The owner selected a second issue-keyed queue and batched recording for hot issues, and no TTL
for pending bundle metadata or manifest chunks; scheduled, monitored cleanup is required. The
proposed `record` role uses a dedicated FIFO queue even in shared-queue mode, while direct mode
remains available. FIFO serializes normal delivery within a visibility lease, but it is not a
fence against expired leases, retries, mode transitions or other writers; datastore conditions
and idempotency remain essential. Lambda FIFO failures require returning unprocessed records after
the first failure, and DLQ redrive can change the effective processing order.

The design conservatively uses non-provisioned Lambda FIFO batches of at most ten. AWS's current
SQS Lambda guide also describes larger total batches with provisioned pollers while its parameter
page still states a ten-record maximum; per-group size and this newer mode need real AWS testing.
The cost and throughput examples and implementation turns are in ISSUE_KEYED_QUEUE_PLAN.md.

## 2026-11-21 — Issue-keyed recording: core and memory contracts

Core models direct/grouped recording, the `record` role and route, mode-dependent requirements,
per-route grouping and validation of grouped store/queue capabilities. The memory queue enforces
serial delivery by group within a physical queue while permitting other groups to progress; its
shared contract covers retries and concurrent pullers. The memory active store implements atomic
1..10-item homogeneous `recordEvents` groups, including duplicate and regression results.

To keep SQL, DynamoDB and SQS untouched until their implementation turns, omitted grouping and
`recordEvents` capabilities mean unsupported, and `recordEvents` is temporarily optional. The
legacy `CoreTopic` type excludes `record` because SQS currently requires a complete map of those
keys; `RoutedTopic` and `TOPICS` include it. Unify the topic aliases and make the migrated adapter
contracts explicit when the remaining adapters are updated. Deployed record handling and FIFO
remain future work; direct remains the default.

## 2026-11-21 — Batched active-store writes

SQLite and Postgres now execute a homogeneous record group in one transaction using the existing
per-issue lock (Postgres acquires its advisory lock before touching event rows). DynamoDB issues
one conditional transaction for the group's distinct new events and one count update; cancellation
reasons identify duplicates before a rebuilt retry, and count/status preimages preserve correctness
under API updates or overlapping delivery leases. A request token is stable inside an individual
request-layer retry and changes when the transaction is rebuilt. The tests cover SQL rollback,
DynamoDB duplicate cancellation, a concurrent resolution, and the transaction-size bound.

With one sequential writer for an issue and groups of ten, DynamoDB Local recorded 20 transactions
for 200 events and 50 for 500 events (0.10 transactions/event, no retries in either run). This
measures the batched store path only, not FIFO throughput or real-AWS contention; the queue-stage
and M3h measurements remain open. Winterbaume issue #61 still requires the concurrency contracts
to run on DynamoDB Local.

## 2026-11-22 — Issue-keyed SQS FIFO and infrastructure

The SQS descriptor derives a dedicated record FIFO queue and FIFO DLQ alongside standard
queues, with per-queue policies and a Lambda event-source mapping. The runtime sends explicit
group and deduplication IDs; same-group entries are not placed in one send request because
partial batch success could reorder them. FIFO push dispatch groups records and conservatively
returns failed and subsequent unprocessed records after the first failure, as Lambda guidance
requires. The future record handler must itself stop processing a group at its first failure.

Winterbaume revision `79c452d2bb2844abf771cfa4a497275c24b46489` retains FIFO creation and basic
send deduplication but drops high-throughput attributes, omits group attributes and permits a
second receive from an in-flight group. The opt-in real-provider FIFO apply uses a scratch module
copy omitting only the discarded settings, checks the FIFO queue and DLQ through APIs, and destroys
them; production HCL is unchanged. The named gap is in WINTERBAUME_GAPS.md and is not yet filed
upstream. Actual FIFO ordering, event attributes, poison handling and throughput remain real-AWS
checks; the record handler and pipeline are the next implementation turn.


## 2026-11-22 — Issue-keyed recording pipeline

The normalizing consumer publishes a versioned normalized record before deleting the staged
envelope. Large records use content-addressed claim checks; grouped overflow payloads are also
content-addressed so conflicting duplicate deliveries cannot overwrite the first event's data.
The record handler commits valid same-issue prefixes in batches of at most ten and 3 MiB,
retries a poison record and its group remainder, and lets other groups advance. Claim checks
must survive queue retention and redrive; their cleanup remains a TODO.

Lambda + SQS defaults to grouped recording and adds a record function alongside split consumers;
standalone remains direct unless explicitly configured with the record role. Neither mode emits
notifications yet. Terraform validation uses the real derived grants and both queue triggers.


## 2026-11-22 — Grouped pipeline measurement and recovery cron

DynamoDB Local with four concurrent memory-queue workers and 40 background events drained 200
hot-issue events in 4.26 seconds and 500 in 9.48 seconds. Both runs had one transaction per hot
event, zero retries and maximum observed same-group concurrency one; four workers were active.
The memory queue dispatches one message per invocation, so this measures serialized single-item
writes, not SQS FIFO batching or AWS throughput. The earlier pre-batched store test achieved
0.10 transactions per event; effective Lambda batch sizes require real AWS measurement.

Lambda schedules staged-envelope recovery every five minutes and ignores staged keys younger
than ten minutes. Recovery messages identify themselves so a message racing successful deletion
of the staged object can be acknowledged without a misleading missing-blob error. The earlier
`Skipping unreadable blob` / `ENOENT` is a separate filesystem startup scan race: a file can
disappear between directory enumeration and opening. Missing files are skipped quietly while
corruption and other read errors still produce warnings.

Winterbaume also drops EventBridge rule default tags on readback, causing a repeat-plan
`tags_all` diff. The emulator apply checks and reports this as the named `tags-eventbridge`
exception; the issue has not been filed upstream. Real AWS must verify tag persistence.

A final rerun measured 3.96 seconds for 200 and 9.80 seconds for 500; both again had one
transaction per hot event, no retries and maximum same-group concurrency one.

## 2026-11-22 — M3h first real AWS deployment (Claude)

Disposable copy of `stacks/aws-dynamodb.ts` (shared queue mode, grouped record stage) in a
sandbox account, ap-northeast-1, provider 6.x. Stack file and scripts stayed in the ignored
workspace; no account details are recorded here.

- **Apply:** 70 resources, no errors. Plan review: only the two function URLs are public
  (`auth NONE`, `principal *`, `InvokeFunctionUrl` plus `InvokeFunction` via URL); no IAM
  statement with a wildcard action or resource. Lambda env holds only binding names.
- **Repeat plan drift (fixed):** the ingest function URL's CORS `allow_headers` /
  `expose_headers` were Title-Case in `infra/modules/aws/lambda-app`, AWS stores them
  lowercased, so every plan proposed an in-place update. Now lowercase; repeat plan empty.
  The emulator did not show this because winterbaume echoes the casing back.
- **Bootstrap:** run twice from the operator machine; both printed the same secret ARN only.
  The secret holds `dsn`, `token`, `orgId`, `projectId`, `stack`, `version`. Terraform destroy
  does not remove it (by design, it is outside state): teardown must delete it separately.
- **SDK end to end (`@sentry/node`, default transport):** 401 on missing and wrong tokens;
  grouping (alpha 3, beta 1, message 1) visible 2.4 s after flush; latest event has Sentry
  tags and exception entries; resolve then a new event reopens with count 4; one envelope
  posted three times counted once.
- **Ingest rate limit:** a 200 / 500-envelope burst through the function URL got 186 / 533
  responses of 429. `IngestService` defaults to 60 events per minute per DSN key and the
  Lambda platform has no setting for it (standalone does). Recorded in TODO.
- **Grouped path under load** (staged envelopes sent straight to the shared queue with the
  project's own S3 / SQS adapters, bypassing the rate limit): 200 hot + 20 background
  drained within 10 s; 500 hot + 50 background drained about 13 s after the last send. Over
  the whole window, 771 events took 190 `TransactWriteItems` (0.25 per event, about four
  events per record batch), zero `TransactionConflict`, zero conditional failures, zero
  throttles, zero Lambda errors, both DLQs empty. Peak concurrency: consumer 10, record 4.
  So real SQS FIFO does serialise per group and batch, which winterbaume could not prove.
- **Recovery cron:** an envelope planted 15 minutes old with no queue message was recorded
  once by the next five-minute run (EventBridge `cron(*/5 * ? * * *)`).
- **IAM (policy simulator, 23 cases):** all as designed. Two first looked wrong only because
  the simulator was not given the condition keys: api `DeleteItem` is limited by
  `dynamodb:LeadingKeys` to metadata key prefixes (allowed for `TOKEN|`, denied for `EV|`),
  and cron `ListBucket` by `s3:prefix` (allowed `envelopes/`, denied elsewhere).
- **Bucket:** plain-HTTP `PutObject` denied by the TLS-only policy; anonymous GET 403.
- **Destroy:** 70 destroyed; the account has no errtraq functions, tables, queues, buckets,
  secrets (including pending deletion), roles, log groups, rules or event source mappings.

Not covered by this run (still on the M3h checklist): per-topic queue mode, FIFO poison
message to DLQ and redrive, visibility expiry, mode-switch drain, RDS / Aurora IAM and VPC,
provider retries and timeouts against real throttling, CloudWatch alarms (the stack creates
none yet), and the S3 ZIP path (bundles are about 200 KB, direct upload is fine).


## 2026-11-22 — Lambda ingest rate configuration

Lambda exposes the same per-DSN-key ingest limit as standalone: 60 event items per minute
by default, a positive safe integer for another limit, or `null` to disable it. The value is
a reserved, ingest-scoped platform environment binding in the derived deployment view, so
Terraform can update it without rebuilding the Lambda bundle. Existing KV counters remain keyed
by project-key ID; whether a separate project-wide limit is desirable remains a product decision.


## 2026-11-22 — CloudWatch alarm emulator probe

The pinned Winterbaume revision accepted CloudWatch monitoring query `PutMetricAlarm`, returned
the basic metric, threshold, queue dimension and SNS action through `DescribeAlarms`, and deleted
the alarm. It omitted the requested `TreatMissingData=notBreaching` in readback. Actual alarm
evaluation, SNS delivery and the AWS provider's protocol and repeat-plan behavior remain
unverified. No alarm implementation was started; the remaining module, descriptor, mutation,
generated-root and emulator work is recorded in TODO.


## 2026-11-22 — M3 CloudWatch alarms

- **Alarms live in the modules.** `infra/modules/aws/sqs` creates `<stack>-<queue>-dlq-messages`
  (DLQ visible messages > 0, maximum, 300 s, 1 of 1) per enabled DLQ and
  `<stack>-<queue>-queue-age` (`ApproximateAgeOfOldestMessage` > 900 s, maximum, 300 s, 3 of 3) per
  physical source queue; `lambda-app` creates `<stack>-<fn>-errors` (`Errors` > 0, sum, 300 s, 1 of
  1) per function. All use `notBreaching` (SQS emits nothing for an idle queue, Lambda nothing
  without invocations), dimensions from the resource's own `name` / `function_name` (so FIFO
  `.fifo` is automatic) and `var.tags`. Alarms hang off the physical resource maps, so a shared
  queue never gets duplicates; a queue without a DLQ gets only the age alarm. The 900 s age threshold
  is deliberately above the default redrive time (5 receives x 180 s) so poison messages reach the
  DLQ alarm first and the age alarm means a stuck or throttled consumer.
- **Optional topic.** `alarmTopicArn` (zod-validated SNS ARN) on `sqsQueue` and `awsLambda` becomes
  `alarm_topic_arn` (null default, regex-validated in HCL) and is the sole `alarm_actions` entry;
  no OK / insufficient-data actions, no topic or subscription is created. The cron DLQ named by
  `cronDlqArn` is not stack-owned and gets no alarm.
- **Emulator.** The Terraform AWS provider 6.73.0 applies alarms against winterbaume (the new
  `cloudwatch` endpoint) and the query `DescribeAlarms` returns name, namespace, metric,
  dimensions, statistic, period, evaluation periods, threshold, comparison and actions, and tags
  survive. It never returns `DatapointsToAlarm` or `TreatMissingData`, so a repeat plan drifts on
  `datapoints_to_alarm` (0 -> n) and `treat_missing_data` ("missing" -> "notBreaching"). That is the
  named, self-verifying exception `cloudwatch-alarm-readback` (plan-check requires the exact
  before / after values; apply-emulated fails if the drift stops reproducing). A hand-built query
  `PutMetricAlarm` drops Period and EvaluationPeriods (300 / 3 came back as 60 / 1) while the
  provider's request keeps them, so a direct API probe is not a valid way to test the gap; do it
  through the provider. The earlier journal note that only TreatMissingData was missing came from
  that query-API probe.
- **Verification shape.** Module contract suites assert counts, keys, metric, dimensions, thresholds,
  periods, missing data, tags and actions, plus invalid-topic rejection. `infra-roots.mjs` derives
  expected alarms from the deployment view (probe outputs injected into scratch copies of both
  modules) and gained an `alarm-topic` grouped per-topic fixture with both topics set. 31
  mutations were added; the first run missed dropped tags on DLQ alarms because every contract
  run used empty tags, so tag assertions now use non-empty tags.
- Not verified anywhere: alarm evaluation, state changes, SNS delivery and the real-provider
  behavior on AWS (left on the M3h real-AWS checklist).


## 2026-11-22 — M3 stage 3 rate-based rejection

Retained the independent fixed-window counter helper from the initial draft and tested batch
ordering, project isolation, bounds, disabled behavior and failure handling. Dropped counts
read only the current aligned window, avoiding a two-window total labeled as one window. The
helper logs aggregate failure context without provider error text or names. The draft consumer
integration was removed because stack configuration, grouped-mode checks, API fields and
grants are not yet wired; rejection remains inactive. The remaining work and the decision
needed for delayed-event buckets are recorded in TODO.


## 2026-11-22 — Rate-rejection stack configuration

Stack-wide `rateRejection` now validates the existing helper bounds and defaults its failure
policy to `allow`, and its configuration reaches the deployed plan, Lambda entry and standalone
platform context. Limits are explicitly rejected until both execution paths and their KV grants
are implemented: accepting a configured limit without enforcing it would silently lose the
operator's protection. The disabled configuration remains usable and the existing pipeline is
unchanged. TODO records the remaining integration and API work.


## 2026-11-22 — Grouped new-issue admission groundwork

The grouped `RecordHandler` can now use the new-issue cap when explicitly given its config and
KV. It reads issue existence consistently before admission, counts each absent issue once per
window within a delivery group, acknowledges rejected records and records approximate drops.
It checks again between chunks while the issue is absent, and only retains a successful admission
for the current invocation. KV retry failures log aggregate metadata without provider details.
The stack and platform guards remain: the consumer path, platform wiring and conditional KV
grants are not yet implemented. A read-after-write contract for `IssueRepo.get` and a DynamoDB
strong-read test make the admission assumption explicit.


## 2026-11-22 — Guarded consumer rate enforcement

The consumer now groups unsuppressed candidates across a delivery batch by project, issue
and received-at fixed window before charging the per-issue counter. Direct mode pre-reads each
candidate issue for the approximate new-issue cap; grouped mode leaves that cap to the record
handler and never reads the store. A KV retry failure happens before any prepared event is
forwarded or recorded, with provider details omitted from logs. Downstream handoff failures
still retry their own deliveries. Standalone and Lambda pass settings and KV to both handlers.
The stack and platform guards remain until conditional KV grants, generated-root assertions
and mutation coverage are complete; the API dropped-count item also remains open.


## 2026-11-22 — Rate rejection deployment access

Rate rejection can now be enabled in a stack. Consumer KV read/write access is conditional on
the per-issue limit or the direct-mode new-issue cap; the grouped record role gets it only for
the new-issue cap. Requirement-derived bindings follow the same scopes. Generated roots test
these combinations and mutation checks remove or add access to exercise the assertions.
Suppression and the issue API dropped-count field remain future work.


## 2026-11-22 — Approximate drop counts on issue responses

Issue list and detail responses expose the current fixed-window approximate dropped count when
a rate limit is enabled. The API receives KV read access only in that case; KV failures omit the
field. Windows use ingest `receivedAt`, matching admission and preserving retry attribution. A
delayed event can therefore increment a past bucket and be absent from the current response;
the response identifies the basis and bounds. When both limits are enabled, the issue limit
sets the dropped-counter window.


## 2026-11-22 — M3 remaining-work hygiene

Reconciled the M3 queue with committed code: the staged DynamoDB layout, grouped FIFO
pipeline and local contention measurement are complete. Direct-mode contention and AWS
verification remain open. Winterbaume VPC readback was filed as issue 62; the emulator
override stays until a fixed revision is pinned.


## 2026-11-22 — Explicit grouped-delivery contracts

Every store now exposes `recordEvents` and explicitly declares whether it supports the operation;
every queue explicitly declares its grouping capability. Unsupported stores reject grouped
recording and grouped stack validation rejects them. `RoutedTopic` is the single routed-topic
type, while the record route remains conditional. The emulator atomicity gap did not reproduce
in one diagnostic run but did on retry, so the pinned exception remains.


## 2026-11-22 — Batch-level rate-rejection failure logging

Consumer and record handlers collect KV failures separately for each delivery batch and emit
one privacy-safe aggregate warning at batch completion. Concurrent increments settle before
retry errors propagate, preventing late failure logs from escaping the batch. Allow/retry
semantics remain unchanged; project-level overrides remain deferred.


## 2026-11-22 — Retention cleanup boundaries

The grouped claim-check key includes a content digest and is reused on republish. BlobStore
exposes neither modification time nor conditional delete, so an age check followed by delete
can remove a newly published claim. SQS source and DLQ retention are 4 and 14 days, but the
current model does not bound repeated manual redrive. Overflow keys are also reused, and
`deleteBatch` does not durably retain blob keys; deleting either the row or blob first leaves a
crash or reinsertion race. Item 3 needs an explicit bounded redrive / publication protocol and
crash-resumable deletion before its cron can safely be wired.


## 2026-11-22 — Immutable record claim publications

New grouped record claim-check writes use a fresh timestamped UUID key per publication attempt.
That prevents a future sweep of an earlier key from deleting an overwritten later publication.
Legacy digest keys still need safe handling, and the publication / redrive horizon and the
cleanup cron remain unimplemented. Fresh retry keys can increase orphan storage until then.


## 2026-11-22 — DynamoDB bundle index repair

Legacy bundle index keys can be repaired using `DynamoStore.backfillBundleIndexes` and an
explicit inventory, without a table scan. Revision-guarded updates reread on concurrent
lifecycle changes and advance the revision themselves. The inventory is supplied externally;
a partial inventory cannot establish that all legacy bundles were repaired. Issues remain
permanent and do not receive a TTL.


## 2026-11-22 — Ingest project-key read policy

Core now derives a distinct `key-read` store capability for ingest, which only calls `getKey`.
The DynamoDB module grants `GetItem` on the table with mandatory `KEY|*` LeadingKeys; API and
consumer retain their broader read policies. SQLite and Postgres map the new capability to their
existing authorization model. Event TTL remains open: it must respect archive commit and project
retention changes; issues never receive TTLs.


## 2026-11-22 — Event TTL arithmetic

Added a tested numeric epoch-seconds calculation for event retention plus grace. It rounds
fractional seconds later and rejects invalid timestamps and overflow. It is deliberately not
wired to event writes: safe activation still needs a durable retention bound and an archival
transition that deals with TTL attributes already present on older events.


## 2026-11-22 — Event TTL activation deferred

The owner deferred event TTL activation to M4 with the archiver, where retention ceiling changes
and transitions from existing TTL-tagged tables can be resolved together. Issues remain permanent.


## 2026-11-23 — Lambda packaging and CORS

Lambda URLs are the only source of ingest CORS headers on Lambda; standalone still emits them.
An optional same-region operator-owned artifact bucket makes Terraform upload encrypted,
content-addressed ZIP objects and deploy Lambda from S3. Without it, the CLI rejects ZIPs above
a conservative 50,000,000-byte direct-upload threshold. The runtime-only core entry removes Zod
from Lambda bundles; minification preserves names. On the shared AWS stack the five ZIPs changed:
ingest 213345 to 65273 bytes, API 206996 to 60467, consumer 193241 to 49057, record 211248 to
63695, cron 193203 to 49018. Real AWS S3 deployment remains for M3h verification.

## 2026-11-24 — Shared identifier limits for stores

Port identifiers were unbounded while Postgres indexes `varchar(255)` columns and the composite
key `JSON.stringify([projectId, id])`. The rule now lives in core (`identifier-limits.ts`) and is
applied by every store through `withIdentifierLimits`, a Proxy returned from the SQL store factory
and from the `DynamoStore` and `MemoryActiveStore` constructors, so adapters cannot diverge and
the 20-odd write entry points are validated in one place. Identifiers (org, project, key, token,
issue, event, release, bundle, erasure IDs) are 1-100 characters of `[A-Za-z0-9._:@+=~-]` starting
alphanumeric: that alphabet never needs JSON escaping, so a two-part key is at most 207 characters.
Indexed text (slugs, public keys, token hashes, release versions, fingerprints, debug IDs, event
user / release / environment values) is at most 255 UTF-8 bytes, which bounds Postgres characters
and btree row size at once. Violations reject with `InvalidIdentifierError` (HTTP API maps it to
400); reads are not validated, an over-long lookup just misses. `normalizeEvent` truncates event
user, release and environment values on code point boundaries, because they are client-controlled
and a rejected event would otherwise poison the queue. Consequences: `vi.spyOn(store, ...)` works
on the guarded store through set / defineProperty traps; the byte-order Postgres test now uses
ASCII ids ("B" before "a") since non-ASCII ids are invalid; Biome needs a `noConstructorReturn`
ignore on the two constructors. `pnpm test:aws-emulated` can fail on its `dynamodb-conditional-
atomicity` gap check ("no longer reproduces") because the emulator race is probabilistic;
rerunning passes.

## 2026-11-24 — Documentation-shaped AWS event fixtures

`packages/platforms/aws-lambda/src/aws-event-fixtures.ts` holds fixtures that follow the AWS pages
cited in each comment: Lambda SQS standard and FIFO events (with-sqs.html), function URL payload
format 2.0 (urls-invocation.html) and EventBridge scheduled events; `aws-events.test.ts` drives
`createHandler` with the real `SqsQueue` push source. Findings: our Terraform sets a constant rule
input `{ job }`, so a default-shaped scheduled event (detail-type "Scheduled Event") or an
EventBridge Scheduler empty event carries no job name and is logged as an unknown job and
acknowledged without running anything, which is correct but silent; real function URL responses
for an unknown DSN key are 403, not 401; a FIFO delivery whose `MessageGroupId` differs from the
envelope `groupKey` fails together with every later record of the invocation. The default
scheduled-event example text could not be fetched verbatim from the docs, so its field values
are the commonly documented ones: M3h real captures should replace it. The aws-lambda package
gained a test-only `@errtraq/queue-sqs` devDependency (pnpm-lock.yaml updated).

## 2026-11-24 — Deployed API token list and revoke

Port: `ProjectRepo.listTokens(orgId, cursor?, limit?)` returns `ApiTokenSummary` (no hash) ordered by
token ID; `revokeToken(orgId, id, at)` is idempotent, keeps the first `revokedAt`, returns null for
an unknown or other-organization token. `ApiToken` gained optional `label` and `createdAt`; no
`lastUsedAt` (recording it would put a write on the auth path). Operator path is CLI only
(`errtraq token list|revoke --stack --org [--id] [--force]`) through the same store construction as
`errtraq bootstrap` (`openDeployedStack`); no HTTP endpoint, so no new scope and no new Terraform
IAM (operator credentials are outside generated roots). Findings: SQL tokens reuse the unused
`scope` column as the organization key (migration 5 backfills it from the stored JSON and indexes
`(scope, pk)`); DynamoDB tokens are indexed on `GSI7` (`ENTITY|tokens|org`, sort by id) and
`revokeToken` finds the item through the existing `KEYID|token|id` marker, so pre-index tokens are
revocable without an index. DynamoDB cannot enumerate unindexed items without a scan, so legacy
tokens are backfilled lazily: any `putToken` or revocation rewrites them with the index, and
`bootstrapDeployed` rewrites a token lacking `createdAt` on rerun (re-reading first to avoid
overwriting a concurrent revocation; a narrow window remains because `putToken` replaces the whole
item). Revoking the last active token needs `--force`; "token in use" has no meaning for an
offline operator command. `summarizeApiToken` is exported from `@errtraq/core/store` because
importing it from the root pulled zod into the DynamoDB runtime bundle (caught by
`runtime-bundles.test.ts`). Gate: typecheck, lint, test, test:postgres, e2e green.


## 2026-11-24 — M3 item 3: blob cleanup by lifecycle rules

Implemented the owner's decisions (see `M3_BLOB_CLEANUP_DESIGN.md`). Findings worth keeping:

- The S3 module has versioning disabled, not enabled, so lifecycle expiry needs no noncurrent
  version rule; add one if versioning is ever turned on.
- An S3 prefix filter cannot exclude a sub-prefix, and overlapping expiration rules expire at the
  earliest age. A rule on `payloads/` would have expired claim checks at the overflow age, so the
  overflow rules are one per leading project-ID digit (`payloads/0` to `payloads/9`).
- No retention caller of `deleteBatch` existed (the `retention` cron job is a placeholder scheduled
  only with archive). `deleteExpiredEvents` now owns event-then-blob ordering; cron wiring is M4.
- The queue port has no dead-letter-now action, so "poison" means logged and retried until the
  queue redrives to the DLQ. Missing claims now log on every attempt.
- "Longest project retention" is runtime data, so the stack carries `maxEventRetentionDays` and
  `bootstrapProject` enforces it (deployed bootstrap creates `min(30, max)`).
- Standalone gets no claim sweep: `queue-memory` has no redrive horizon and `blob-fs` has no mtimes.

## 2026-11-24 — M3h second real AWS deployment (Claude)

Disposable per-topic copy of `stacks/aws-dynamodb.ts` in the sandbox account, ap-northeast-1,
with `rateRejection` (20 events / 60 s per issue, 5 new issues / 60 s), an operator-owned
artifact bucket for S3-backed ZIPs, and an operator-owned SNS topic for every alarm, subscribed
by a probe queue. Stack file and scripts stayed in the ignored workspace. Torn down completely
(89 resources, plus the secret, topic, probe queue and bucket).

- **Apply / repeat plan:** 89 resources, repeat plan empty. Only the two function URLs are
  public. All five functions deploy from hash-named S3 keys. A stack change that alters the
  embedded plan replaced the five objects and updated the functions in place (5 added, 5
  changed, 5 destroyed); the old objects were deleted and the repeat plan was empty again.
- **Rate rejection:** hot issues of 200 and 500 events each recorded exactly 20; the per-issue
  counter counts every attempt (75 seen, 55 dropped for the 500 burst, the rest cut at ingest by
  the 600 / min key limit). Ten new fingerprints in one window created exactly five issues; three
  in the next window were all admitted. `approximateDropped` only reports the current window, so
  it reads 0 once the window has passed. The SDK e2e script waits for hot counts that the limit
  never allows, so it cannot be reused unchanged on a stack with `rateRejection`.
- **CORS:** preflight, success and 403 responses each carry one set of `access-control-*`
  headers. The API URL sends none.
- **Missing-claim poison (FIFO record queue):** logged on each of five receives exactly one
  visibility timeout (180 s) apart, then moved to the DLQ. Redriven with a move task, it failed
  five more times and returned to the DLQ. It holds its message group for
  `maxReceiveCount × visibility` (15 min) each time; only that issue's group is affected.
- **Alarms:** all nine start in OK with `TreatMissingData=notBreaching` read back (winterbaume
  #68 is emulator-only). Function errors: ALARM about 40 s after a forced failure. DLQ depth:
  ALARM about 3 min after arrival, even though the message stayed only about 80 s, because the
  5-minute Maximum still sees it. Queue age: needs three 5-minute periods above 900 s, so it fired
  about 28 min after the stuck message was sent. Every transition reached the SNS probe queue.
- **Pausing a consumer:** disabling the ingest event source mapping is not immediate. One event
  sent seconds after the mapping reported `Disabled` was still consumed. While the consumer was
  paused, staged-envelope recovery re-queued the waiting envelope, so two copies were in the queue.
  Both were later processed with the count still 1 for that event.
- **Redrive of manually moved messages:** a move task fails with `CouldNotDetermineMessageSource`
  for messages that were sent to the DLQ by hand rather than by the redrive policy;
  `--destination-arn` is required. With it, both copies were consumed and counted once.
- **Tokens:** `token list` shows the bootstrap token without plaintext. `token revoke` refuses the
  last active token without `--force`. With it, the API returned 401 on the next request, and a
  repeated revoke kept the original `revokedAt`.
- **Lifecycle:** real S3 accepted all 14 rules (claims 30 days, overflow prefixes 37 days, envelopes
  14, staging 7, multipart abort 7). Expiry itself is not observable in a single run.
- **Tooling:** `pnpm build` (`tsc -b`) left `dist/` older than changed sources and reported
  nothing, so the CLI would have run stale code; `tsc -b --force` rebuilt it. Not investigated.
- **Not covered:** RDS / Aurora IAM (no RDS module; needs an operator-built VPC and database),
  visibility-expiry races, mode-switch drain, throttling retries, FIFO high-throughput attributes.

## 2026-11-24 — `tsc -b` does not notice stale or missing outputs (Claude)

TypeScript 5.6+ decides "up to date" from each project's `.tsbuildinfo` alone: deleting
`packages/core/dist/cursor.js` and running `tsc -b` did not recreate it, and a real source edit is
only picked up because the build info hashes change. So a `dist/` that is deleted or replaced by
older files outside tsc stays wrong, and `errtraq` (which runs from `dist/`) runs old code; this is
what the second M3h run hit. How that `dist/` went stale was not established. `pnpm build` now runs
`scripts/build.mjs`: `tsc -b`, then a check that every non-test `src/**/*.ts` of each referenced
project has a `dist/**/*.js` at least as new, then `tsc -b --force` on the stale projects only, and
a failure if anything is still stale. A source that was only touched costs one forced rebuild of its
project; the next build is a no-op. Putting `tsBuildInfoFile` under `dist/` would only cover
deletion, not old files restored over current ones.

## 2026-11-24 — Packaging outside the workspace implemented (Claude)

The M3 packaging design is implemented; `pnpm verify:packaging` packs the 16 public packages,
installs the tarballs with npm into `.agents-workspace/tmp/pack/project` and drives the installed CLI
(validate, build, vendor-mode `infra generate`, `terraform init -backend=false` + `validate`, one
envelope into the standalone bundle). Findings: (1) the throwaway project sits below this
repository's `pnpm-workspace.yaml`, so root discovery picks the repository unless `--root` is passed
(the check passes it); (2) an installed `@errtraq/terraform-modules` is inside the project root, so
"inside the root means relative" produced `../../../node_modules/...` sources; the default is now
`relative` only outside `node_modules`; (3) `npm install a.tgz b.tgz ...` satisfies the exact
`workspace:*` versions pnpm writes (`0.0.0`) from the tarballs given together, no overrides needed;
(4) a stack built by a second copy of core fails in `resolveStack` with "A resolved stack copy cannot
be re-parsed" (the resolved marker is a registered symbol, the order cache is per module), so the CLI
checks `stackOrigin` first. The test for the `package.json` fallback of `projectRoot` uses the OS
temporary directory, because every directory under this repository has a workspace file above it.

## 2026-11-25 — M2 review follow-ups N9, N12-N15

N9 reproduced (depth 25 shared object exceeded the time bound); `checkValue` now records finished
walks per (value, owner, mode flags) in a WeakMap, so a shared sub-object is walked once per
context and reported once (a duplicate error path for a shared object is no longer emitted). True
cycles are still caught by the depth cap before the walk, so the test asserts "some issue" rather
than one message. N12: the adapters' policy outputs are `policies.<capability>.<purpose>` but
`key-read` uses `policies.read` and `metadata-delete` uses `policies.write`, so a strict
"output name equals capability" rule would reject valid descriptors; the check instead rejects a
read-only capability (`read`, `key-read`, `list`) whose policy output name or key path contains
`write`, `delete` or `produce` (the escalation direction); the reverse swap is not detected. A
`<role>_url` stack output requires that role in `platform.config.http`. N14: a missing existing
key is now reported once at `<selection>.existing.<output>` (a path change); the
conflicting-settings error names the roles. N15 bootstrap ownership: deployed bootstrap is the
operator-run `errtraq bootstrap` (M3g), so nothing else owns it. N15 type and trigger-setting
items need a descriptor design decision and were left open in TODO.md.


## 2026-11-25 — Rate-rejection integration coverage

Added `rateRejectionPipelineSuite` (testing package, run on the in-memory and SQLite stores) driving the real consumer and record handler in both record modes. It pins two behaviours that follow from non-idempotent counters: a retried delivery is charged again (a retry can be dropped wholesale by the per-issue limit), and a redelivered event is skipped before charging in direct mode but charged and counted as dropped in grouped mode, where the consumer has no event read; the record is still stored once. A failed KV increment under `retry` is not charged, so its redelivery is charged once. No production code changed and no contradiction with the documented design was found.


## 2026-11-25 — Exact rate counting and per-project overrides

Exact counting uses `increment` returning 1 on a marker key (`rate:charged:<kind>:<project>:<id>:<bucket>`) as the first-attempt signal, then stores the decision at `rate:outcome:...`; retries read it. `<kind>` (`issue`, `new`, `dropped`) is an addition to the brief's key shape: the two limits and the dropped counter have different windows, so bucket numbers alone could collide. KV key length (2048 bytes in DynamoDB) is far from reached and the KV table grants carry no key-prefix conditions, so no grant or snapshot changed. Non-obvious points: (1) the dropped counter needed its own per-event marker, otherwise a retry of an already-rejected event (outcome reused, no charge) would count a drop again, and a cap rejection of a later event of the same issue is a first attempt as an event even though the cap decision is reused; (2) when any marker increment fails under `retry`, markers this call already set are deleted, else the retry would see marker above 1, no outcome and admit uncharged; (3) duplicates of one event inside a single call share the first one's verdict, because the follower would otherwise find its leader's outcome not yet written and be admitted; (4) a failed outcome write (or crash) leaves marker without outcome, so the retry admits once uncharged, even for an event that was over the limit, and concurrent attempts by two consumers can do the same; (5) an increment that returns 1 after a TTL expiry is a first attempt again, which is acceptable because markers live twice the window.

Per-project overrides: `Project.rateLimits` is stored in the existing JSON-shaped project rows (memory, SQL `data` column, DynamoDB item), so no SQL migration was needed. Effective limits are resolved in `RateRejector` (memoized per delivery batch scope only) with `effectiveRateLimits` (min with the stack, clamp invalid, ignore disabled) and written through `validateProjectRateLimits`. Open point reported to the owner: the grouped-mode consumer has no store and no store grant, so it cannot read project overrides; rather than silently ignoring them, the CLI rejects an `issueEvents` override for grouped stacks (the Lambda plus SQS default). The new-issue cap override works in both modes because the record handler has the store. A project read failure is not a KV failure: it fails the delivery batch for retry regardless of `onKvFailure`, with no provider text logged. `errtraq bootstrap` applies limits to a new project only and fails with a conflict when the project exists with different ones.


## 2026-11-25 — Grouped consumer reads project records

Owner decision: instead of rejecting a per-project `issueEvents` override for grouped stacks, the grouped consumer gets a read-only store capability `project-read` (new `PortRequirement` row, feature `rate-project`: grouped mode and `issueRateLimit` enabled), so the limit-disabled and cap-only stacks keep a consumer with no store policy or table binding. Non-obvious points: (1) the model could express it without a design change because store capabilities already carry per-capability policy outputs (`key-read` is the precedent); the DynamoDB module gained `project-read` = `GetItem` on the table ARN only (indexes excluded) with `ForAllValues:StringLike dynamodb:LeadingKeys ["PROJECT|*"]` and `Null LeadingKeys false`; `PROJECT|*` cannot match `PROJECTSLUG|...` because the separator follows the prefix, and it cannot name one project, so the grant covers every project record (the same exposure as store `read` on those items, but without events, issues, keys or tokens). (2) SQL stores are not per-function: the Postgres IAM descriptor maps `project-read` to the single `rds-db:connect` read policy and the secret and SQLite descriptors to `null`, so the restriction exists only in code. (3) Code-level narrowing: `ConsumerOptions.projects` (a `Pick<ProjectRepo, "get">` built by `projectReader`) replaces passing the store; Lambda and standalone pass it only for grouped mode with the per-issue limit, and the Lambda handler throws at construction when that limit is on but the function has no store, rather than silently ignoring overrides. Previously a consumer sharing a function with the record role received the whole store in grouped mode. (4) `project-read` is in the read-only capability set that rejects write-class policy outputs. (5) Existing-resource stores must supply `policies["project-read"]` only when a grouped stack enables the per-issue limit.

## 2026-11-25 — Package scope renamed for GitHub Packages

The owner releases from `github.com/moriyoshi/errtraq` to GitHub Packages, which requires the npm scope to be the owning account, so every `@errtraq/<name>` package became `@moriyoshi/errtraq-<name>` (CLI binary still `errtraq`). Earlier JOURNAL entries keep the old names. Code or tests that derive an adapter name from a module specifier must strip the `errtraq-` prefix from the package segment, not take the segment after the slash: a `runtimeModule` can carry a subpath. Consumers need `@moriyoshi:registry=https://npm.pkg.github.com` in `.npmrc`.

## 2026-11-25 — RDS PostgreSQL test fixture (M3h run 3)

- The fixture lives in `infra/fixtures/aws/rds-postgres/`, outside `infra/modules`, so the module
  loops (shape snapshots, `infra:mutate`) never see it. `scripts/infra-validate.mjs` has a separate
  fixture loop (fmt, validate, mocked `terraform test` at both pinned provider versions). It has no
  `contract.tftest.hcl` output-shape snapshot and no mutation entries: the mutation registry targets
  product module controls, and the fixture's assertions are plain behaviour tests.
- Mocked tests need defaults the provider schema does not give: `aws_db_instance.master_user_secret`
  (a list block, otherwise the proxy secret policy has no ARN), a `prx-` suffixed proxy ARN for the
  `proxy_resource_id` output, and `aws_db_proxy_default_target_group.name` (mock strings start with a
  random character and fail the provider's "first character must be a letter" validation).
- In `.tftest.hcl` assertions, comparing a resource attribute list or `keys()` result to a literal
  list is false (tuple vs list); compare with `toset(...)` or `join(",", ...)`.
- Partial bring-your-own inputs are rejected with preconditions on `aws_vpc.this` (subnets or
  security group without `vpc_id`) and `aws_db_subnet_group.this` (`vpc_id` without two subnets);
  tests use `expect_failures` on those resources.
- Backups are off (`backup_retention_period = 0`), which the provider and RDS allow for a
  non-replica instance; there is no PITR, acceptable for a throwaway fixture.

## 2026-11-25 — Deployed bootstrap function (`bootstrap` role, `errtraq bootstrap --remote`)

Built from `.agents-docs/M3H_RUN3_PLAN.md`; design in ARCHITECTURE.md "Deployed bootstrap". Non-obvious points:

- **Role model:** `bootstrap` is a sixth `FunctionRole`, enabled only by listing it in the Lambda platform `roles` (the same opt-in `record` uses), with a required `bootstrapSecretName` (and invalid without the role). `ALWAYS_SPLIT_ROLES` makes `physicalFunctions` give it its own function whatever `split` says; the `lambda-app` module independently rejects a grouped, URL-exposed or triggered bootstrap function. Requirement rows are store and KV `read` and `write` only.
- **Secret handling deviates from the sketch:** the function runs the existing create-or-read vault (`awsBootstrapVault`, moved from the CLI into the platform package so the Lambda bundle can include it), so the IAM statement is `CreateSecret`, `DescribeSecret` and `GetSecretValue` on `secret:<name>-??????` instead of `PutSecretValue`. A pre-created empty secret would add a value-less Terraform resource and lose the atomic CreateSecret handoff that makes concurrent runs converge. Unverified on real AWS: that `CreateSecret` authorizes against the name-pattern ARN (the usual prefix-scoped pattern) and that IAM `?` matches the six-character suffix; run 3 should confirm both.
- **Admin secret as a capability:** `adminSecret` is modelled as a store capability `admin` with a `null` policy, a new `store-admin` feature row for the bootstrap role (enabled only when the store declares `admin`), and a `secret` binding restricted with `capabilities: ["admin"]`. The existing binding-by-capability filter then delivers the binding and the derived `GetSecretValue` grant to the bootstrap role alone. This needed one validation change: a `null` policy is accepted when a secret binding names the capability explicitly (before it required the adapter-wide `secret-binding` authorization).
- **Migration identity:** with the admin binding, `migrate()` connects as admin over verified TLS, creates the IAM user, grants `rds_iam`, connect, schema usage/create and privileges on existing tables, then migrates as the IAM user so it owns the tables (later migrations need no grants). The integration test in `postgres.integration.test.ts` (needs `ERRTRAQ_TEST_POSTGRES`, creates a stand-in `rds_iam` role when absent) covers this against a real server. `rds_iam` is a hard `GRANT`, not skipped when absent: a non-RDS target is a configuration error.
- **No silent secret leaks:** the response is built from fixed fields; failures return `{ok:false, error:{code,message}}` where the message is either our own validation or an allowlisted prefix of the stack's own messages, otherwise fixed text; logs carry only the error class and a short code. The CLI rebuilds the response from validated fields, prints only `errorType` for function errors, and never prints provider text. Unknown request fields are refused by name only, so a smuggled secret is never echoed.
- **Module quirks:** `data.aws_region.current.region` (not `.name`, deprecated in provider 6) with `count`-gated data sources so non-bootstrap stacks gain no data lookups; the module injects `ERRTRAQ_BOOTSTRAP_SECRET_NAME` itself (reserved binding name), so the generated-root `expected_env` adds it for the bootstrap function; root probe compares `jsondecode`d policies because Terraform re-serializes keys sorted. The old `lambda-extra-env` mutation anchor changed with the env merge.
- **Not done:** retention is not a request field (the CLI has no retention flag; the stack's `bootstrapRetentionPolicy` is baked into the artifact); the module's inline-policy size precondition does not count the small bootstrap statement.

## 2026-11-25 — M3h run 3 in progress: fixture and stack findings (Claude)

Run log and state stay in the ignored `.agents-workspace/tmp/m3h3/run/`; account, VPC and resource ids
are not recorded here. Findings so far, appended as the run produces them:

- **Proxy auth (fixed before the run, adaae4d):** an RDS Proxy that only registers the master secret
  cannot log in as an IAM-only database user, so the store's user would have failed through the proxy.
  The proxy needs `default_auth_scheme = "IAM_AUTH"` and its own role needs `rds-db:connect` on the
  instance's `dbuser:<db-id>/*`; with that, no per-user secret is registered.
- **`rds.force_ssl` never converges with `apply_method = "immediate"`:** it is a static parameter, RDS
  reports it back as `pending-reboot`, and every repeat plan showed an in-place update. The fixture
  now sets `pending-reboot`. The parameter group is attached at instance creation, so TLS was enforced
  from the start either way (and PostgreSQL 15+ on RDS defaults it to 1).
- **PostgreSQL major `17` accepted** as `engine_version` on create (was an open question).
- **Fixture apply** (created network): 31 resources, no internet gateway or NAT, repeat plan empty
  after the fix above.
- **Stack apply** (`aws-postgres`, direct variant): 98 resources; every function in the fixture subnets
  with one security group; function URLs only on ingest and api; `rds-db:connect` is exactly
  `dbuser:<db-id>/errtraq_app` on every role; the master secret readable only by the bootstrap role.
  Repeat plan empty, and the record FIFO queue reads back `DeduplicationScope = messageGroup`,
  `FifoThroughputLimit = perMessageGroupId` (the high-throughput readback check passes).
- **Operator pitfall:** the generated root's `SUBNETS` / `SECURITY_GROUPS` / `ADMIN_SECRET_ARN`
  variables come from `TF_VAR_*` exported by `env-from-fixture.mjs`; a repeat plan in a fresh shell
  without them fails with "No value for required variable" rather than planning drift.
- **Every Postgres Lambda function crashed at init:** `pg` is CommonJS and calls `require("events")`;
  the Lambda bundle is ESM, so esbuild's `__require` shim threw `Dynamic require of "events" is not
  supported` at module load. Run 2 only deployed DynamoDB stacks, which bundle no CommonJS code that
  requires builtins. Fixed with an esbuild banner that defines `require` via `createRequire`. The
  regression test imports each built bundle in a plain `node` child process: vitest's module runner
  supplies `require()`, so importing the old bundle inside a test succeeded and hid the bug.
- **`errtraq bootstrap --remote` with an SSO profile:** the CLI signs with `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` only (README "Bootstrap"), so a profile-only shell gets
  `CredentialsUnavailable`; export the session first with `aws configure export-credentials --format env`.
- **`infra generate` refuses an output directory holding `plan.bin`** ("files not owned by the
  generator"); Terraform's own working files are allowed, saved plans are not. Keep plan files outside
  the generated root.
- **RDS-managed secrets were rejected before any request:** the Lambda Secrets Manager source checked
  ARNs against the user-created name character set (`A-Za-z0-9/_+=.@-`), but RDS names the master
  secret `rds!db-<uuid>`. The deployed bootstrap failed with `SecretReadError` (`InvalidIdentifier`) in
  about 2 ms. `!` is now allowed. Unit tests elsewhere already used `rds!db-...` ARNs, but only as
  Terraform inputs, never through this reader.

## 2026-11-25 — Operator AWS profile resolution lives in the CLI only

`errtraq bootstrap` (direct and `--remote`) and the token and project-limit commands used to sign
with `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` read straight from the environment, so SSO and
profile shells failed with `CredentialsUnavailable`. `packages/cli/src/aws-credentials.ts` now
resolves credentials once with `fromNodeProviderChain()` (env keys win, as in the SDK) and the
profile `region`, and hands the adapters an environment with those values filled in. This keeps the
SDK out of the platform package and the Lambda bundles, and covers every environment-reading adapter
(DynamoDB, KV, Secrets Manager, RDS IAM) without changing them. Trade-off: credentials are resolved
once per command, not refreshed, which is fine for these short commands.

## 2026-11-25 — M3h run 3, part A results so far (Claude)

- **A4 deployed bootstrap:** after the two fixes above, a 3 s timeout interrupts the first run, the rerun
  completes, and a third run reports everything "already existed". The CLI resolved the operator's SSO
  profile with no exported keys. CreateSecret through the `secret:<name>-??????` pattern is authorized
  (open question closed). The secret holds `dsn`, `token` and the vault's id metadata (`orgId`,
  `projectId`, `stack`, `version`); logs hold no DSN or token.
- **A5:** events stored and grouped through RDS with IAM tokens; no password or DSN in any function
  environment and the admin secret binding only on bootstrap; every `VpcConfig` matches; no ENI
  permission errors; every role reached its services through the created network's endpoints.
- **A6 TLS:** connecting by IP is refused (`ERR_TLS_CERT_ALTNAME_INVALID`); a single unrelated root
  (ISRG Root X1) is refused (`SELF_SIGNED_CERT_IN_CHAIN`). The planned negative "system CA bundle instead
  of the RDS bundle" was a wrong premise: on real Lambda `/etc/pki/tls/certs/ca-bundle.crt` verifies the
  RDS certificate, although that file in the public `public.ecr.aws/lambda/nodejs:22` image holds no
  `Amazon RDS` subject, and no single Amazon or Starfield root verifies it. The deployed filesystem's
  system trust evidently differs from the published image; do not use the image to reason about which
  bundles trust RDS. The `ca` option itself is honored (pg passes `ssl` to `tls.connect`).
  `/var/runtime/bootstrap` sets `NODE_EXTRA_CA_CERTS` only in regions with three dashes in the name.
- **A7:** every role's `rds-db:connect` is exactly `dbuser:<db-id>/errtraq_app`; cron has no database
  access; a second database user without an IAM grant is refused with `28000`.

## 2026-11-25 — M3h run 3: RDS Proxy needs a different CA and no startup timeouts (Claude)

- **Proxy TLS:** RDS Proxy presents an ACM certificate chained to the public Amazon roots. The
  Lambda RDS bundle `/var/runtime/ca-cert.pem` holds only RDS CAs (118 of its 119 certificates in the
  nodejs22 image), so every connection through the proxy failed with `unable to get local issuer
  certificate`. With an IAM `resourceId` of `prx-...` the default CA path is now the system bundle
  `/etc/pki/tls/certs/ca-bundle.crt`; `sslRootCert` still overrides it.
- **Proxy startup options:** RDS Proxy refuses `statement_timeout` as a startup parameter ("Feature not
  supported: RDS Proxy currently doesn't support the option statement_timeout"). Through a proxy the
  pool now sends no session timeouts and bounds statements with pg's client-side `query_timeout`; a
  per-connection `SET` would pin proxy connections and defeat multiplexing. The binding
  `ERRTRAQ_POSTGRES_VIA_PROXY=true` (derived from the `prx-` id) carries the choice to the runtime.
  Without a server-side bound, a statement abandoned by the client timeout may keep running on the
  server until it finishes.
- **Bootstrap through a proxy:** with `default_auth_scheme = "IAM_AUTH"` the proxy accepts IAM logins
  only, so the bootstrap role's admin step (master user and password) cannot run through it; point the
  stack at the instance for the first bootstrap, or provision the IAM user before switching.
- **A8/A9:** an api execution environment lived 19.3 minutes with fresh tokens per connection and no
  auth failure; 30 concurrent requests hit the sandbox account's 10-concurrency limit (10 ok, 20
  throttled), so the concurrency half ran at 10. The visibility race fired on the second try (40
  receives for 10 events) and the count stayed exactly 10.
- **A10 result:** after the two proxy fixes, events are stored and read through the proxy with every
  role's `rds-db:connect` scoped to the `prx-` id only. The bootstrap function pointed at the proxy fails
  with `PostgresProvisionError` / `0A000`: the admin client (`postgres-admin.ts`) also sends
  `statement_timeout` as a startup option, and an `IAM_AUTH` proxy would refuse the master password
  anyway. Bootstrap must target the instance; the stack has one host for all roles, so a proxy
  deployment bootstraps before switching `host`/`resourceId` to the proxy (or a later per-role host).

## 2026-11-25 — M5a: sentry-cli upload path (Claude)

Verified against sentry-cli source (getsentry/sentry-cli master, 3.8.2 installed from npm for the
opt-in test) and symbolic's `sourcebundle/mod.rs`:

- The chunk part is named `file` or `file_gzip` and the multipart filename is the SHA-1 of the
  uncompressed chunk (not the field name). `ChunkServerOptions` requires `url`, `chunksPerRequest`,
  `maxRequestSize`, `chunkSize`, `concurrency`, `hashAlgorithm`; `accept` is not read by the CLI.
- Assemble: after the first call sentry-cli uploads only `missingChunks`, then polls; `not_found` and
  `error` are both fatal while polling, so a finished assembly must keep answering `ok` (here: via the
  assembly record plus the active debug-ID owner, because chunks are deleted after success).
- A source bundle is `SYSB` + version (8 bytes) followed by a ZIP with `manifest.json` and `files/...`.
  Real bundles parse with fflate as is (the zip writer records absolute offsets); the parser also tries
  the ZIP after the 8 bytes, and falls through when a candidate has no `manifest.json` (fflate does not
  throw on shifted offsets).
- `ReleaseRepo.beginBundle` retry is an exact-equality check including `pendingExpiresAt` and the
  manifest key. See the review-fix entry below for how retries adopt the stored row.
- sentry-cli re-uploads of an unchanged build get new checksums (attributes such as release differ) but
  identical debug IDs; exclusive ownership would make that a conflict, so equal debug-ID digests are
  treated as already registered. Partial overlap stays an error. Deletion/replacement semantics are open.
- Lambda function URLs cap the request body at 6 MB (about 4.5 MB raw after base64), hence 1 MiB chunks, 3 per request.
- Not done (M5b, see TODO(M5) markers): symbolication in the consumer, cleanup cron wiring (the
  cleanup function already removes the assembly record), Cloudflare. `dist` and release `url` are
  accepted but not stored; org-level release lists take no cursor and scan all projects.

## 2026-11-25 — M5a review fixes: retries adopt the stored row (Claude)

- **Assembly record removed, `ReleaseRepo.getBundle` added.** The first design pinned ids in a blob
  written with an unconditional put, which two concurrent first attempts could overwrite with
  different manifest keys. Now the bundle id is the checksum and the store row is the single source
  of truth: an attempt reads the row, adopts it if pending, or creates it; if `beginBundle`
  conflicts it re-reads, adopts the winner and deletes its own manifest blob.
- **Manifest keys never reused:** the key embeds the attempt's `pendingExpiresAt`
  (`manifests/<project>/<checksum>/<expiry>`). A new row only exists after cleanup finished
  removing the previous one, and the expiry (now plus one hour, from the clock) differs per attempt,
  so a later row never shares a key with an earlier one unless two attempts share a millisecond, in
  which case the blob content is identical and the same attempt-race rule applies. Cleanup now also
  deletes the bundle blob (it used to leave it).
- **Expired pending attempts:** a retry past `pendingExpiresAt` (or one already claimed by cleanup)
  runs `cleanupPendingBundle` itself. Claiming is atomic and resumable, so racing the cron is safe,
  and then starts over with a fresh row.
- **`ProjectRepo.listByOrg`:** SQL filters on the existing `scope` column. DynamoDB has one project
  index partition shared by all organizations, so it filters one global page per call (examined-key
  cursor, short pages allowed). This is O(all projects) across a full listing, which is accepted for
  tens of projects; a per-organization index entry would need a second GSI row or a migration
  (open: TODO).
- **Other:** the release named by a request is ensured before any short-circuit; chunks are dropped
  after deterministic failures (bad ZIP, checksum) and kept after transient ones; organization
  release lists read everything and refuse beyond 1000 releases.

## 2026-11-25 — M3h run 3, part B results and teardown (Claude)

The `aws-dynamodb` stack ran within the sandbox account's Lambda concurrency limit of 10 (owner's
choice; no quota increase). Findings:

- **Contention at the account limit (B2, B4):** 500 same-issue events at HTTP concurrency 5. The
  ingest queue's poller took all 10 execution slots, so ingest returned 429 for part of the burst
  (185 of 500 in direct mode, 36 in grouped mode); every accepted event was counted exactly once and
  no queue redelivered into a DLQ. Direct mode: 302 conditional-check failures and 204 transaction
  conflicts on the store table, all retried, no throttling. Grouped mode: zero of either, because the
  per-issue message group serializes the writes. A full 500-of-500 run needs a consumer
  `maxConcurrency` (topic settings) below the account limit.
- **Mode switch (B4):** a 100-event backlog queued in direct mode was recorded exactly once after the
  apply to grouped mode, and a second 100-event backlog was drained through both queues before the
  apply back to direct mode removed the record queue. In this stack the record role runs in the
  platform's `shared` function, not a function named `record`; run scripts that looked for `record`
  misreported the mode until fixed.
- **Exact rate counting (B5):** in both modes, 15 events whose first delivery failed after the charge
  were counted once (a double charge would have admitted 5); in grouped mode six new issues all
  survived a record-handler redelivery against a cap of 6. Overrides: 50 above the stack's 20 is
  refused by the tighten-only rule, 5 admits exactly 5 of 12, clearing restores 20 of 25.
  `errtraq project rate-limits` reads the deployed store directly and needs `ERRTRAQ_STORE_TABLE` and
  `ERRTRAQ_KV_TABLE` in the operator environment (as the README says).
- **SQS and S3 edges (B3):** raw U+FFFE / U+FFFF bodies refused, the adapter's escaped form
  round-trips; exactly 1 MiB accepted, 1 MiB + 1 byte refused, size counted in UTF-8 bytes; batch over
  1 MiB refused as a whole; FIFO id limits as the adapter assumes; receive count 1, 2, 3, then the
  message moves to the DLQ on the next receive (not on the third). No SQS throttling code was produced
  at this rate. S3: unsigned payload accepted, 404 inside the granted prefix and 403 outside, encoded
  listing uses `+` for space and `%2B` for plus, multipart abort allowed; AbortMultipartUpload of an
  unknown upload id returns 204 rather than 404 `NoSuchUpload` (the adapter does not depend on it).
- **FIFO high-throughput readback (B6):** empty repeat plan after the grouped apply and
  `messageGroup` / `perMessageGroupId` read back, as on the postgres stack.
- **Event fixtures (B7):** SQS standard and FIFO, function URL POST, GET and OPTIONS, and EventBridge
  scheduled events captured and scrubbed (account, region, hosts, IPs, user agents, ids replaced);
  kept in the ignored run workspace pending a decision to commit them.
- **Teardown (B8):** the SSO session expired mid-destroy; Terraform failed to refresh it while the AWS
  CLI's cached role credentials still worked, so the remaining destroy ran with those credentials
  exported to the environment. Everything the run created is gone; the resource-tagging API kept
  stale entries for deleted EC2 endpoints, a NAT gateway and an event source mapping for a while.

## 2026-11-25 — M5b: JS symbolication and bundle-cleanup wiring (Claude)

- **Symbolicate before normalize.** `normalizeEvent` computes culprit, fingerprint and issue ID, and
  the grouped consumer routes by issue ID, so frames must be rewritten before it. This matches
  ARCHITECTURE ("symbolicate, then group") but changes the fingerprint of any minified-frame event
  once its map exists; events without a matching `debug_meta` image group exactly as before. An event
  processed before its map was uploaded is never re-symbolicated (no async re-processing exists).
  The overflow blob must be rewritten too: `item.payload` (raw bytes) was what overflowed, so the
  consumer re-serializes the payload when symbolication changed it.
- **Function names come from the caller frame's token.** A source map token names the identifier at
  the position; at a call site that is the callee, i.e. the function of the next (inner) frame, not
  of the frame holding the position. Frames are oldest first, so frame i takes `name(i-1)`. The
  outermost frame keeps its minified function. `colno` in events is 1-based; trace-mapping columns
  are 0-based.
- **`openBundleZip`.** fflate does not throw on shifted offsets, and the helper picks the candidate
  (with or without the `SYSB` header) that contains `manifest.json`; a filter that excludes the
  manifest therefore makes it fall through to the wrong candidate. Every filter passed to it must
  select `manifest.json`.
- **trace-mapping resolves `./` in sources** (`webpack://app/./src/a.ts` becomes
  `webpack://app/src/a.ts`), so frame `abs_path` is the resolved form.
- **New store capability `release-read`.** DynamoDB `GetItem` conditioned on `DEBUG|*` and `BUNDLE|*`
  leading keys; the grouped consumer needs it because it has no store `read`. SQL maps it to the
  runtime database policy. The direct consumer already has `read`, so the requirement row is
  grouped-only. A new `ddb-release-read-unscoped` mutation guards the condition.
- **Cron now has a store.** `bundle-cleanup` needs `ProjectRepo.list` plus the pending-bundle
  protocol, so the cron role gained store `read`/`write`/`metadata-delete` and blob `delete`
  (a seventh policy on the per-topic cron function, still below the inline budget) and therefore the
  store environment binding and, for external Postgres, the secret read. Tests that asserted a
  store-free cron (cold-start build test needs `AWS_REGION`) were updated deliberately.
- **Standalone has no scheduler**, so the platform drives `bundle-cleanup` itself (on start and
  every 15 minutes) instead of deriving cron triggers (those stay function-compute only for this
  job, like `staged-recovery`). blob-fs gained `expireOlderThan(prefix, cutoff)` (mtime based)
  because it has no lifecycle rules; core detects it structurally (`ExpiringBlobStore`).
- **Not verified:** the opt-in sentry-cli e2e now also processes a minified event and reads it back
  through the API, but could not be run here (no sentry-cli binary offline, installs denied). The
  step computes the frame position from the injected file because `inject` shifts the map.

## 2026-11-25 — M5b review fixes: stable grouping, fair cleanup, bounded memory

- **Grouping must not depend on the attempt.** The first cut fell back to raw frames from the third
  receive attempt on a transient bundle failure, which gave one event two issue IDs. Transient
  failures now always retry (the DLQ policy is the backstop); only permanent outcomes
  (`js_no_source`, `js_invalid_source`) keep the raw frames, and `js_symbolication_unavailable` is
  gone. A map activated between attempts can still regroup a redelivered event, so the safety net is
  the store: `recordEvent`/`recordEvents` are idempotent on `(projectId, eventId)` whatever the
  issue (the event row is keyed by project and event ID and shares a transaction with the issue
  update in DynamoDB; SQL and memory check the event first). The `ActiveStore` contract now pins
  the cross-issue duplicate (no second issue, no count).
- **Symbolication moved after the suppression and direct-mode duplicate checks.** Both read only
  identity fields and the event ID, so grouping is unchanged; the event is normalized once as sent
  and again only when frames were rewritten.
- **bundle-cleanup fairness without state.** The cron role has no KV and no blob write, and a new
  MetaRepo record would be a port change across three stores, so no cursor is persisted. Instead
  each run counts the projects and visits a circular window starting at `fnv1a(now) % total`, with
  at most 10 bundles per project. Every project is reached with probability 1; the cost is one extra
  project listing per run. Revisit with a real cursor if the project count makes that listing hurt.
- **blob-fs `expireOlderThan`** keeps an in-process cursor per prefix (resume after the last examined
  key, wrap at the end) and an `scanLimit` option; a restart simply starts again from the front.
- **Memory bounds:** parsed-map cache is now 8 maps / 64 MiB by weight (map plus `sourcesContent` at
  UTF-16 size) and context lines are capped at 128 K characters per event.

## 2026-11-25 — Emulator pin moved to winterbaume-server v0.2.9

- **Pin:** the emulator is now the release `winterbaume-server-v0.2.9` (commit `70006139231c1d0569a6ec303a671e53b8d6e6c3`),
  not source revision `79c452d`. `scripts/aws-emulated/emulator-binary.mjs` holds the tag, commit, SHA-256 of the
  `aarch64-apple-darwin` prebuilt asset and of `source.tar.gz`; `install.mjs` installs the prebuilt asset for pinned
  hosts and otherwise builds the pinned source as before. Other platforms' asset checksums were not available and are not
  pinned (they fall back to a source build). `ERRTRAQ_WINTERBAUME_BINARY` still overrides everything.
- **Fixed in v0.2.9 (exceptions removed):** #50 ownership-control deletion, #51 to #54 tag readback (DynamoDB, IAM, S3,
  Lambda mapping), #58 S3 UTF-8 keys (the local patch, its installer and the dedicated S3 contract runner are gone; the
  BlobStore contract now runs inside `run.mjs` on the plain binary). Lambda permission conditions (#44), the mapping
  `FunctionName` filter (#46) and `ScalingConfig` (#45) were also found fixed by direct probes; they had no exceptions
  in the harness.
- **Still reproducing:** #48, #49, #61 (19 of 100 rounds with more than one winner), #62, #64 to #66, #67, #68, #69.
  See the status table in `WINTERBAUME_GAPS.md`.
- **Harness note:** the repeat-plan "gap no longer reproduces" checks in `apply-emulated.mjs` now collect every vanished
  gap before failing, so one run lists all removable exceptions instead of one per five-minute run.
- **Final sweep after teardown:** every region was swept by tag, IAM and S3 globally, and the run's
  region by name for every service used. Only two leftovers existed, and the run's teardown check did
  not look for them: `/aws/rds/proxy/<proxy-name>` log groups (empty), which RDS Proxy creates itself
  outside Terraform and which survive `terraform destroy` of the proxy. They were deleted by hand. A
  fixture or product module that creates an RDS Proxy should either manage that log group in Terraform
  or document its removal.

## 2026-11-25 — aws-lambda platform defaults to Node.js 26 (nodejs26.x)

* `nodejs26.x` (Amazon Linux 2023, launched 2026-11-20, deprecation 2029-04-30) is now the default for `runtime` in the platform schema, the build manifest, infra generation and the `lambda-app` module variable. `nodejs22.x` (deprecation 2027-05-30) stays selectable for existing deployments. The supported set is exactly `nodejs22.x` and `nodejs26.x`: the zod schema rejects anything else with a message listing them, the module variable has a `contains` validation, and the build keeps a defensive check. The esbuild target follows the runtime (`node22` / `node26`; esbuild 0.28.2 accepts `node26`). The standalone build stays on `node22`.
* Image facts (public.ecr.aws/lambda/nodejs:26, Node 26.13.1): `/var/runtime/ca-cert.pem` holds the 118 RDS CAs, `/etc/pki/tls/certs/ca-bundle.crt` the public roots including Amazon Root CA 1-4 (both identical to nodejs22), and `/var/runtime/bootstrap` keeps the same NODE_EXTRA_CA_CERTS logic. Current ESM bundles with the createRequire banner load and export `handler`. The Postgres CA defaults are therefore unchanged.
* Changing the default changes the generated `runtime` input for stacks that did not set it; their next `terraform plan` shows an in-place Lambda runtime update. Pin `runtime: "nodejs22.x"` to avoid that.
* The AWS provider's runtime enum is checked at validate time: 6.32.1 (the previous floor) rejects `nodejs26.x`, 6.73.0 and 6.74.0 accept it. The `lambda-app` module therefore requires `>= 6.73.0, < 7.0` (the earliest version verified here; an intermediate version may also work but could not be checked offline). `scripts/infra-validate.mjs` reads each module's floor and tests only the pinned versions at or above it, the generated roots run on 6.73.0 only, and `scripts/infra-mutate.mjs` rewrites the constraint by pattern. Root stacks that declare `>= 6.32.1` still resolve, since Terraform intersects the constraints.

## 2026-11-25 — M4a: archive contracts, Parquet staging codec, fault wrappers

- Parquet library choice: `hyparquet` 1.32.0 (reader) and `hyparquet-writer` 0.18.0 (writer), both MIT, zero other
  dependencies, pure JS (SNAPPY built in). The writer pins `hyparquet` 1.32.0 exactly, so both are pinned to match
  and install a single copy. Non-obvious: the package roots of both resolve, under the default export condition, to
  a `node.js` entry that imports `fs`; only the `browser` condition reaches the node-free `index.js`. Core therefore
  imports the explicit `hyparquet/src/index.js` and `hyparquet-writer/src/index.js` subpaths (exported by both
  packages), which resolve identically under every condition and keep the Workers bundle free of `node:*`.
  `scripts/layering.mjs` allowlists exactly those two specifiers; `scripts/layering.test.js` bundles `packages/core`
  with esbuild (neutral platform, workerd/worker/browser conditions) and asserts no `node:` inputs.
- Timestamps are written as INT64 MICROS with the UTC TIMESTAMP logical type by passing an explicit schema (the
  writer's auto schema only emits MILLIS). `tags` is a real MAP and round trips through `hyparquet`.
  On decode the `event` JSON is authoritative; the promoted project/event/issue/received_at columns are
  cross-checked and a mismatch is reported as a corrupt batch.
- Staging key parts are escaped with a stricter set than `encodeURIComponent` (also `-`, `.`, and the other
  unreserved punctuation) so `-` is an unambiguous separator and `/` in the batch id (`<projectId>/<seq>`) does not
  create sub-prefixes.
- `MemoryArchiveStore.hasBatch` is now day-range-scoped like the partition-pruned probe: it answers true when a row of
  the batch falls inside the inclusive range. It ignores masked rows (the real probe has the same blind spot, see
  M4_PLAN risk 5). The contract `stage` option now takes the batch id and there is a `stageUnreadable` option.
- Fault wrappers are functions (`faultyArchiveStore`, `faultyActiveStore`, `faultyMeta`, `faultyBlobStore`) over a
  shared `FaultInjector`; plans fire once on the Nth call of `<scope>.<method>` before or after the effect.

## 2026-11-25 — M4b: archival planner and worker, staging dropped

- The M4a Parquet staging codec was removed in this slice by owner decision. The archive is the
  write-ahead record: the worker passes rows straight to `ArchiveStore.append({batchId, dayRange, rows})`,
  and the DELETE step reads the id list back from the committed snapshot with the new
  `ArchiveStore.batchEventIds(projectId, batchId, dayRange)`. The state machine is SCAN, COMMIT (CAS
  `committing`, then append), MARK, DELETE, CLEAR. Costs: one archive read per batch; engines that need
  a file to commit (native committer, Cloudflare) are out of M4 and would bring staging back as an
  engine option (codec in git history at 14c8c9e). `hyparquet` and its layering allowlist entries went
  with it; core keeps only `archive-rows.ts` (row definition, day range, bounds).
- Resume of a `committing` batch: `hasBatch` true goes to MARK; false means nothing durable existed, so
  the worker CAS-clears `batch` and rescans, rebuilding under the same batch id (the rows may differ if
  late events arrived). Residual race, documented in ARCHITECTURE: a stale holder that passed its COMMIT CAS,
  then stalls longer than the lease, may append late. The engine's idempotence on the batch id (first
  append wins) prevents duplicates, but if its row set differs from the rebuilt batch the rebuilt
  `dayRange` could prune some of its rows out of `batchEventIds`, leaving them for a later batch that
  would archive them twice. This needs a stall longer than 2x the invocation timeout between the CAS and
  the append call; M4j must also account for erasure interacting with it.
- Overflow blob keys cannot be recovered from the archive (the archived event is self-contained, the key
  is dropped), so the worker writes a small nonce-keyed manifest `archive-overflow/<batch>-<owner>-<n>.json`
  before the COMMIT CAS and records its key in `batch.overflowKey`. Only keys, no PII; orphans from a
  crash before the CAS are swept in M4h.
- The `archive-planner` and `retention` cron jobs are wired in `createCronHandler` by optional
  arguments; the `retention` job now touches the store, so the AWS cold-start test uses the still
  unimplemented `erasure-worker` job as its no-op. The scan contract already covered cursor-free restart
  after partial deletes, so no `EventRepo` contract change was needed (DynamoDB emulated suite not rerun).
- Lease `until` is `now + 2 x invocationTimeoutMs` (default 15 min), renewed by every CAS; the lease is
  released by CAS before a continuation is sent. The fault matrix (every operation of every call, before
  and after, on memory and sqlite) is generated from a dry run's call counts, so new operations are
  covered automatically.


## 2026-11-25 — M4c: federated EventQueryService

- `EventQueryService` (core `event-query.ts`) merges the active store and the archive by `(receivedAt, eventId)`, dedupes on `eventId` and resumes both sources from the last emitted key. Its public cursor holds only that key (scope `["fed", project, issue, from, to, order]`). Source cursors stay internal: sources are paged with `after` and drained through their own cursors until they hold `limit` rows, because a source page may be empty or short with `hasMore` true (examined-key cursors).
- `hasMore` needs no probe row: each drained source either is exhausted or holds at least `limit` rows, so `merged > limit || a source has more` is exact, including when every source row is a duplicate.
- The cursor is federation-shaped whenever an archive is configured, so it survives the watermark moving mid-pagination; a source cursor is rejected as invalid. Without an archive the service is a pure pass-through, so API output is byte-identical.
- Archive reachability: `from < archivedThrough` (or no `from`), and not an ascending resume at or past the watermark. Rows between COMMIT and MARK exceed the watermark but still live in the active store, which is always queried, so that skip is safe.
- Test design: `federationSuite(factory)` in `packages/testing` (random placement over hot, cold and both tiers with tied timestamps, both orders, limits 1..100, issue and range filters, exact `hasMore`, empty-tier cases, archive-skip checks, cursor hygiene, and archival running between pages by crashing the M4b worker right after its first DELETE call so rows sit in both tiers). Mutation check: removing dedupe or the `more` flags fails the suite. Runs on MemoryActiveStore and sqlite (memory and file) with MemoryArchiveStore. `MemoryArchiveStore.getEvent` now accepts the hint argument.
- Gap: no platform passes `archive` to `createApiApp` yet (standalone, Lambda); that is M4g and M4i.

## 2026-11-25 — M4d: Lakekeeper + winterbaume + DuckDB spike (containers only)

- Environment: `docker/archive/compose.yaml` (postgres:17.12, Lakekeeper v0.15.1 migrate+serve allowall, debian:bookworm-slim with the aarch64 winterbaume v0.2.9 binary bind-mounted, node:26.13.1 runner with `@duckdb/node-api@2.0.1-r.1`), `pnpm archive:smoke` brings it up, runs `scripts/archive-local/container/spike.mjs`, prints PASS/FAIL per question, `down -v`; SKIPs without Docker. Owner changed D10: winterbaume runs in a container, not on the host. Full record: `.agents-docs/M4D_LOCAL_ARCHIVE_SPIKE.md`.
- Results: Lakekeeper warehouse validation passes against winterbaume (`sts-enabled false`, path style, `s3-compat`); DuckDB 2.0.1 ATTACH (`ACCESS_DELEGATION_MODE none`, static secret) CREATE v3 and v2, INSERT, DELETE, read back all work; v3 DELETE writes real Puffin deletion vectors (`added-dvs`), v2 writes Parquet positional deletes; default warehouse allows format versions 1, 2, 3; `iceberg_rewrite_data_files` still refuses v3 (works on v2).
- Not available: the open-source Lakekeeper image registers only `soft_deletion`, `tabular_purge`, `task_log_cleanup`; the expire_snapshots, remove_orphan_files and optimize queues return `QueueNotFound`. Snapshot expiry, orphan cleanup and compaction are not catalog-provided locally.
- winterbaume handled 3 multipart uploads, 112 ranged GETs and a 50k-row (48.7 MB) insert with matching checksums and no 5xx. Only quirk: an unsigned bucket PUT returns 404 instead of 403 (harmless).
- M4b operations verified: day-pruned `hasBatch` and `batchEventIds` (files read 3 down to 1), D13 sort order honored on write. `iceberg_use_metadata_log` staleness did not reproduce against Lakekeeper; keep it false anyway.

## 2026-11-25 — M4e: Iceberg REST catalog client and archive-iceberg skeleton

- New package `packages/adapters/archive-iceberg`: index exports exactly `manifest`, `create`, `infra`; `./stack` and `./catalog` subpaths. `package.json` sets `errtraqWorkersRuntime` to the catalog entry so the layering check treats the client as a Workers bundle (no `node:*`, only `fetch`, WebCrypto via `aws-signing`). No new dependency (zod and the workspace `aws-signing` only).
- Iceberg ids are 64-bit and real snapshot ids exceed `Number.MAX_SAFE_INTEGER`; `JSON.parse` silently rounds them. The client parses responses with `parseJsonPreservingLongs` (unsafe integer literals become decimal strings, safe ones stay numbers, so id fields may be either type) and writes ids in commit requests as bare literals via `Long`. Anything that reads `snapshot-id` from `loadTable` must normalise with `longString`.
- Prefix and base URI: effective properties are `defaults` overlaid by `overrides`; `prefix` is used verbatim as one path segment (S3 Tables returns it already percent-encoded, so it must not be encoded again); an overridden `uri` replaces the base for later calls. Lakekeeper advertises `uri` from the request Host, so behind a proxy a wrong advertised host would break later calls (no escape hatch added yet).
- Error mapping: 409 on commit is `CatalogCommitConflictError` (retryable); 409 elsewhere is `CatalogAlreadyExistsError`; 5xx or a dropped connection on commit is `CatalogCommitStateUnknownError` (not retryable, the commit may have applied; reload and compare); 429/502/503/504 and network failures outside commit are `CatalogTransientError` (retryable); 401/403 `CatalogAuthError`; 404 `CatalogNotFoundError`. The REST error body is kept on `error.body`, or a 512-char `rawBody` when it is not the envelope. OAuth2 token failures never echo the token endpoint body. The client does not retry commits itself; the M4f engine adapter owns the reload-and-retry loop.
- Auth: none, bearer, OAuth2 client credentials (single-flight refresh, 60 s expiry skew, one forced refresh on 401, token endpoint from config, then `oauth2-server-uri` from the catalog config, then `<uri>/v1/oauth/tokens`), SigV4 through `signAwsRequest` with signing name `s3tables` (override `glue`). Stack config holds secret identifiers (`tokenSecret`, `clientSecretSecret`) resolved lazily via `secretSource`; SigV4 credentials come from the `awsCredentials` binding. SigV4 and OAuth2 are verified against fixtures only, not live endpoints.
- Lakekeeper v0.15.1 (M4d stack) against the client: config, createNamespace (409 on repeat), createTable v2, loadTable (404 before create), commit `set-properties`, and a failed `assert-ref-snapshot-id` requirement returns 409 (`CommitFailedException`) all behave per spec. `GET /v1/config?warehouse=<unknown>` returns 404 `NoSuchWarehouseException`. `remove-snapshots` and `set-snapshot-ref` are covered by request-shape tests only (no engine to create snapshots yet).
- The opt-in test needs Lakekeeper published on the host: `docker/archive/compose.ports.yaml` maps `127.0.0.1:18181`; run steps are in the header of `lakekeeper.opt-in.test.ts`.


## 2026-11-25 — M4e review: rowDelete follows the owner's D3, Long sentinel hardened

- The M4e skeleton declared `rowDelete: "position-delete"` from the D3 recommendation (v2), but the owner chose format v3 from the start, so the manifest and the skeleton store now declare `deletion-vector`. M4f must keep it truthful once the engine creates the table.
- `stringifyWithLongs` used the marker string `__long__<digits>`, so an ordinary string value equal to that marker (a table property) would have been written as a bare number. The marker now starts with U+0000, which `JSON.stringify` always escapes, so no string value can collide; regression test added.
- Reviewed by Claude Opus; implemented by Claude Sonnet.

## 2026-11-25 — M4f: DuckDB engine and the archive-iceberg ArchiveStore

- Layout: `@moriyoshi/errtraq-archive-iceberg/duckdb` (`src/duckdb/`). `engine.ts` is the only file importing `@duckdb/node-api` (2.0.1-r.1, the version the M4d spike verified); `sql.ts`, `attach.ts`, `session.ts` and `store.ts` are pure, and the store talks to an `EngineSession` interface, so retry, idempotent append and paging are unit-tested with a fake session. The main entry `create` has no engine (it would pull the native module into Workers-bound bundles); Node platforms pass `create` from the subpath as `bindings.createEngine` (`TODO(M4g)`).
- Parameters: every value is a bound `?`. Event rows travel as one JSON array parameter that `from_json(CAST(? AS JSON), '[{...}]')` plus `unnest` turns into typed columns (TIMESTAMPTZ, `MAP(VARCHAR, VARCHAR)` tags work through the Iceberg writer), so no event data is in SQL text. DDL, `ATTACH` and `CREATE SECRET` cannot take parameters; they use `quoteLiteral` on operator config only, identifiers are validated against a strict pattern (the config schema constrains `namespace`), and snapshot ids are checked as integers before `AT (VERSION => n)`.
- Idempotency: DuckDB cannot tag snapshots, so `append` probes `archive_batch` with the day-pruned `hasBatch` before every INSERT attempt (a conflicted INSERT with a lost outcome may have committed) and reports the oldest snapshot holding the batch, found by binary search of `iceberg_snapshots` with time travel (`AT (VERSION => id)` works through Lakekeeper). A repeated append therefore returns the same `{snapshotId, rowCount}` as the first, which the contract requires even after later batches. The snapshot id is informational (non-monotone after row deletes). All operations of one store share one connection and run one at a time.
- Sessions: the long-lived session attaches once and sets `iceberg_use_metadata_log = false`; `ensureTable` opens its own instance and closes it (partition spec and sort order must exist before any INSERT). DuckDB does not create `home_directory`, so the engine `mkdir -p`s it. A second store (own instance) sees batches committed by another instance immediately; no re-attach was needed against Lakekeeper.
- Commit conflicts: 8 concurrent single-row writers from separate instances against Lakekeeper produced no conflict (DuckDB or the catalog absorbs them), so the real conflict text is unobserved. `isCommitConflict` matches 409 / CommitFailed / requirement-failed wording and is unit-tested only; verify against S3 Tables compaction in M4m.
- Format version: config `engine.formatVersion` defaults to 3; `capabilities.rowDelete` is `deletion-vector` for 3 and `position-delete` for 2 (`rowDeleteModeFor`). The manifest keeps the static v3 default. Sort order is D13 `(project_id, issue_id, received_at)`, partition `day(received_at)`, `write.delete.mode = merge-on-read`.
- Catalog: opt-in `catalog.ignoreServerUri` (default false) keeps calling the configured URI instead of a server-advertised `uri` (Lakekeeper derives it from the Host header). It affects only the REST client of this package; DuckDB's own ATTACH follows what the server says.
- Contract: `archiveStoreContract` takes `erasure?: boolean` (default true); the engine passes false, skipping the three erasure cases until M4l, and a separate always-on case asserts the declared `rowDelete`. The opt-in run (`duckdb/lakekeeper.opt-in.test.ts`) passed in the compose network and from the host; the host needs winterbaume published, so `compose.ports.yaml` now maps `127.0.0.1:15555`.
- Install note: `pnpm install` from a plain shell was refused by the sandbox classifier, but the lockfile was resolved from a node:26.13.1-bookworm-slim container (`pnpm install --lockfile-only`), and a later `pnpm exec` in the worktree synced `node_modules` itself (frozen lockfile), fetching the darwin binding. Typecheck and tests ran on the host afterwards; the opt-in run also ran in a container with a separate copy of the tree. macOS `tar` adds `._*` AppleDouble files that break biome in that copy; delete them there.
- Implemented by Claude Sonnet; review by Claude Opus pending.

## 2026-11-25 — M4f review

- Reviewed by Claude Opus; implemented by Claude Sonnet. Accepted as committed: bound parameters for every value, identifier and snapshot-id validation for the DDL / time-travel literals, the per-attempt `hasBatch` re-probe that makes `append` idempotent across lost conflict outcomes, and the `erasure` switch on `archiveStoreContract` (default on, no assertion dropped).
- Open for M4i (TODO): the S3 secret is created once per long-lived session, which breaks with expiring role credentials; and a session broken by a fatal error is never reopened.
- Install note: the host `pnpm install` was refused; the lockfile was resolved in a container, but a later `pnpm exec` in the worktree let pnpm sync `node_modules` itself and fetch the darwin DuckDB binding onto the host. Reported to the owner.

## 2026-11-25 — M4g: standalone archive wiring and the archive end-to-end

- Wiring: the standalone platform already carried the `archive.project` consumer and the optional `archive` binding (M4b); M4g adds the archive to `createApiApp` (federation), a default cron handler built from `createCronHandler` when the embedder supplies none (the `Cron handler required` throw would otherwise reject every archive stack, since `deriveTriggers` schedules `archive-planner`, `retention` and `erasure-worker` for a standalone stack with an archive), and `prepare` calling `ensureTable` when the archive store has it. `erasure-worker` is not scheduled in process until its handler exists (`TODO(M4j)`).
- Cadence: the cron schedules are hourly, too slow for local runs and tests, so the standalone config gained `cronIntervalSec` (only `archive-planner` and `retention`): a job with an override runs on `setInterval` instead of the UTC minute matcher; a job still running is skipped on the next tick (the worker is lease-fenced anyway). `stacks/local-archive.ts` uses 5 s and 30 s. There is no short-retention stack knob: `retentionDays` is per project (integer days, D12), so tests and the e2e seed events older than the project's age instead.
- Engine wiring: the main-entry `create` of archive-iceberg takes `bindings.createEngine`. `constructStack` gained an `extraBindings(selection)` hook; the CLI (`archive-engine.ts`) dynamically imports `@moriyoshi/errtraq-archive-iceberg/duckdb` only when the selection is `archive-iceberg`, so commands and bundles without an archive never load the native binding. `errtraq build` imports the subpath statically in the generated entry for such stacks and marks `@duckdb/*` external. `assertImplementedConsumerTopics` takes an `implemented` list: the CLI (single process) passes `archive.project`; the AWS deployed path keeps rejecting it until M4i.
- `errtraq migrate --stack`: constructs the standalone stack, runs `store.migrate()` and, when the archive selection exposes `ensureTable`, creates the Iceberg table (idempotent, prints created or already exists). `errtraq dev` does the same table creation in `prepare`.
- Image (D6): the standalone image of an archive-iceberg stack runs the whole pipeline, so the generated Dockerfile `npm install`s `@duckdb/node-api` (version constant `DUCKDB_NODE_API_VERSION`, tested to equal the adapter dependency) next to the bundle; the `iceberg` and `httpfs` extensions are installed by DuckDB at first start (`runtime-install`, needs egress). Baking the extensions (`preinstalled` mode) is the AWS image recipe, `TODO(M4i)`. Verified: built and ran the image with host networking against the compose stack; the planner ticked and the table bootstrap passed. The repo has no digest pinning anywhere (base `node:22.23-bookworm-slim`, compose tags), so none was added.
- Opt-in e2e (`pnpm e2e:archive`, `scripts/e2e-archive.mjs`): migrate, seed 40 old and 20 recent events into sqlite, `errtraq dev`, a separate DuckDB session counts and compares event ids in Iceberg, the events API is paged with limits 1, 7, 25, 100 right after the commit (DELETE possibly pending) and after it settled (gapless, duplicate-free, newest first), plus one archived event detail. The Iceberg table outlives a run in the shared warehouse, so each run tags its issue and event ids.
- Fault matrix on the real engine (`duckdb/fault-matrix.opt-in.test.ts`): one batch of two events per cell and a fresh namespace per cell (batch ids restart at `1/0`); 14 cells covering every `archive.append`, `archive.batchEventIds` and `meta.compareAndSetArchiveState` call before and after, plus the real `hasBatch` probe (crash before and after the probe, recovery appends nothing) and the abandon-and-rebuild case. `scenario` in `packages/testing` now takes an external `archive` and `recover` is exported for this. All passed against Lakekeeper + winterbaume.
- Found: the PORT_REQUIREMENTS rows for `feature: "archive"` still demand `blob` capabilities for purpose `staging`; D5 dropped staging, so the rows (and the `blob.*.staging` capability lines in `errtraq validate`) are stale, to be removed with the M4i requirement rewrite. In the full `lakekeeper.opt-in.test.ts` run the M4f case "creates the table once" failed every time in a full-file run, also on a freshly created stack (`partition-specs.at(-1)` empty), yet passes when selected alone and the table metadata is right afterwards; M4g touches nothing on that path (only the `scenario` helper and the stack factory changed), cause unexplained.
- Implemented by Claude Sonnet; review by Claude Opus pending.

## 2026-11-25 — M4g review

- Reviewed by Claude Opus; implemented by Claude Sonnet. Accepted as committed: DuckDB stays out of core, http and the standalone platform (the CLI imports the `/duckdb` subpath dynamically, the generated entry statically, only for `archive-iceberg` selections); the standalone default cron handler (archive stacks could not start without one); per-job overlap skip on the in-process timers; `implemented` topics list keeps the AWS path rejecting `archive.project` until M4i.
- Open: the M4f opt-in case "creates the table once" fails when the whole `duckdb/lakekeeper.opt-in.test.ts` file runs and passes alone (TODO); it is opt-in only, so the default gate is unaffected.

## 2026-11-25 — M4f follow-ups: credential refresh, session reopen, the table-creation opt-in flake

- Flake root cause: the opt-in case read `partition-specs.at(-1)` and `sort-orders.at(-1)`, assuming the newest entry is last. Lakekeeper returns both lists in no fixed order (observed `sort-orders` as order 1 then the empty order 0, so `.at(-1)` was the empty one), so the case failed or passed by luck of the server's ordering, which happened to differ between a run of the whole file and a run of one case, and flipped across fresh stacks. The table was always right. The test now selects the spec and order named by `default-spec-id` and `default-sort-order-id`. Stable over repeated full-file runs.
- Credential refresh: `S3Credentials` and the `awsCredentials` binding gained optional `expiration` (Date, ISO string or epoch ms). The session exposes `credentialsExpireAt()` and `refreshCredentials()` (re-resolves the credentials and runs `CREATE OR REPLACE SECRET`). `DuckDbArchiveStore.exclusive` renews the secret when the expiry is within 5 minutes, and for repeatable operations (reads, `hasBatch`, `batchEventIds`, `append`, which re-probes `hasBatch` first) renews and repeats once after an S3 auth failure (`(HTTP 403)`, `ExpiredToken`, `InvalidAccessKeyId`, `RequestExpired`; matcher in `duckdb/recovery.ts`). A failing `CREATE SECRET` is rethrown with the credential values redacted, since DuckDB can echo the statement; the secret text is never logged. Chosen over DuckDB's credential-chain secret provider because that needs the `aws` extension (which the Lambda spike avoided, and which would add a second credential path next to the secret ids and the binding) and it still gives no control over when the chain is re-read.
- Session reopen: after any failure that escapes an operation, the store runs `SELECT 1` on the cached session; if that fails too the session is closed and dropped, so the next operation opens a fresh one, and the original error is still the one thrown. A healthy session survives ordinary query errors. This probes liveness rather than matching DuckDB's fatal-error wording.
- Not verified: winterbaume does not check credentials, so the 403 path is covered by unit tests with the fake session only; the opt-in smoke checks the proactive renewal (an `awsCredentials` binding whose expiry is inside the skew is re-resolved on every operation).
- Implemented by Claude Sonnet; review by Claude Opus pending.

## 2026-11-25 — M4h: archive-side housekeeping

- Shape: `core/src/archive-housekeeping.ts` (`runArchiveHousekeeping`, `purgeProjectArchive`), run by the `retention` cron job when `retention.archived` and `retention.housekeeping` are set. Chosen over a new cron job name because `retention` already owns "how long data lives" and a new name changes `CRON_JOBS` and with it every generated schedule (M4i). The tick: per project the lag alarm and hard retention, then the orphan manifest sweep, then optional snapshot expiry. One project failing is logged and does not stop the tick; the errors are rethrown as an `AggregateError` at the end.
- Lease discipline: every mutation (retention delete, manifest sweep, project purge) goes through `ArchiveWorker.acquire`; a busy lease means skip until the next tick (project purge throws `ArchiveBusyError`); an acquired lease holding a leftover batch first runs `driveBatchToCompletion`, then the work, then `release`. So housekeeping never deletes archive rows under a `committing` or `committed` batch (M4_PLAN risks 4 and 5). `ArchiveWorker.release` became public.
- Port: `ArchiveStore.deleteOlderThan(projectId, cutoff)` (exclusive, project-scoped) and `deleteProject(projectId)`, both returning `{ rowsDeleted }`, idempotent. Per project rather than global so the lease applies and a per-project archive retention can follow. Contract cases first in `archiveStoreContract` (run on the memory fake, the engine opt-in, and `housekeepingSuite` on memory and sqlite stores). DuckDB: `DELETE ... WHERE project_id = ? AND received_at < CAST(? AS TIMESTAMPTZ)` with bound values; DuckDB answers a DELETE with one `Count` row. The retention delete runs under the same commit-conflict retry as the other statements.
- D12: `archiveRetentionDays` did not exist; it is a stack-wide option of the housekeeping job (standalone config key `archiveRetentionDays`), not a `Project` field (that would touch every store schema). It must exceed the project's `retentionDays`; a project where it does not is skipped with a warning, because the delete would then remove rows that were never archived. Retention increases need no policy here (explicit deletes only), which is part of why D14 is safe to defer.
- Snapshot expiry and orphans per catalog, what is actually done: nothing physical. S3 Tables expires snapshots and removes unreferenced files by its own maintenance configuration (minimums 1 hour and 1 day, set in M4i HCL; not observed to apply within the spike window). Lakekeeper OSS v0.15.1 registers only `soft_deletion`, `tabular_purge`, `task_log_cleanup` (M4d), so no expiry or orphan removal. DuckDB `iceberg_expire_snapshots` is main-only and metadata-only (M4 research), so no verified engine path exists; `expireSnapshots` stays `TODO(M4l)` and the job calls it only when `snapshotExpiryDays` is set (the port rejection `UnsupportedQueryError` is tolerated and logged). Consequence for operators: rows removed by retention or project deletion remain readable by time travel and physically stored until M4l and catalog maintenance; this is retention, not erasure.
- Orphans: the sweep lists `archive-overflow/`, groups manifests by the project in the key, and deletes them under that project's lease (an unknown project has no worker, so its manifests go unguarded). Only manifests are deleted, never the payload keys they list: after an abandoned batch the active rows still reference those payloads, and a finished batch already deleted its own. Overflow payload blobs left by crashed deletes (`payloads/<projectId>/`) are not swept: `BlobStore` has no age metadata and ingest writes the blob before the event, so an age-less sweep could delete a live payload; the bucket lifecycle rule stays the mechanism. Raw envelopes stay with `staged-recovery` and their lifecycle rule.
- Lag alarm: the oldest active row below the project's hot cutoff, `lagMs` over `lagAlarmMs` (default 3 hours, three missed hourly planner runs) logs `warn` "Archival lag alarm" with `alarm: "archival-lag"`, project and lag; the count is in the result. No external alerting (log-based metric filter is M4i or later). Complements the per-run `lagMs` already logged by the worker.
- Opt-in: `duckdb/lakekeeper.opt-in.test.ts` passed against Lakekeeper + winterbaume (own compose project `errtraq-m4h`, ports 28181 and 25555): the full contract including the two new cases, plus a retention and project-deletion test across day partitions on format v2 and v3. Caveat recorded in the test: after every row of a batch is deleted `hasBatch` is false, which is exactly why the lease discipline matters.
- D14 decision record: the DynamoDB `ttl` delete strategy is NOT implemented in M4h. Deferred to after M4m on the owner's recommended option. Reasons: explicit deletes work, TTL needs a durable retention-ceiling policy plus a data-loss alarm, and DynamoDB items written before activation carry no TTL. The archival worker keeps rejecting `deleteStrategy !== "explicit"` (`UnsupportedQueryError`); the TODO about the persisted scan cursor in `ArchiveState` stays open with that item. The `ttl-backstop.ts` helper remains unwired.
- Not done / for M4i: AWS scheduling (the `retention` job on the cron role has neither the archive binding nor the lease path there), `archiveRetentionDays` in the stack schema, an operator-visible metric. Project deletion has no caller yet (`purgeProjectArchive` is the hook for the future flow).
- Implemented by Claude Sonnet; review by Claude Opus pending.


## 2026-11-25 — Review of M4h and the M4f follow-ups

- Reviewed by Claude Opus; both implemented by Claude Sonnet in parallel worktrees and merged on main (the opt-in test file, TODO and JOURNAL conflicted only by additions on both sides).
- M4f follow-ups accepted: proactive secret renewal inside a 5 minute skew, one repeat after an S3 auth failure only for operations that are safe to repeat (`append` re-probes `hasBatch`), a `SELECT 1` liveness probe deciding whether to drop the cached session, credential values redacted from rethrown CREATE SECRET errors. The flake was a test bug (array position instead of `default-spec-id` / `default-sort-order-id`). The real 403 path is unverified because winterbaume does not validate credentials.
- M4h accepted: housekeeping inside the `retention` job (no new cron name, so no schedule churn before M4i), every archive mutation under the project's lease after any in-flight batch is driven to completion, per-project `deleteOlderThan` / `deleteProject` with contract cases first. Operator-visible consequence worth keeping in mind: retention and project deletion on the archive are logical only (deletion vectors) until M4l provides snapshot expiry and a physical rewrite path.

## 2026-11-25 — M5 follow-ups: bundle-cleanup cursor and DynamoDB project-org index

- `bundle-cleanup` persists its position as a small blob (`cron/bundle-cleanup-cursor`, JSON `{c, s, l}`: project-list page cursor, items already done in that page, page limit). Each run resumes there, examines at most `maxProjects`, and deletes the blob after a full lap. A bundle-limit stop resumes right after the project that hit it. A corrupt or unreadable value is ignored and a stale page cursor restarts from the first project. `runBundleCleanup` takes `persistCursor`; `createCronHandler` and standalone enable it; without it the old hash-window fallback remains. Why blob: the cron role had no `kv` read and no blob `write`. KV read plus write would be two more inline policies and pushed the per-topic cron role to 9, failing the 10240-character inline-policy guard test (`(policies + 1) * 1024 < 10240`); blob `write` is one policy (cron now has 8). IAM change: cron blob `write` on the primary bucket (`PutObject`); the cron role could already delete any object there. The archive-gated cron `kv` write row is unchanged.
- DynamoDB `listByOrg` now queries the new sparse `project-org` GSI (GSI12PK `ENTITY|projects-by-org|<orgId>`, GSI12SK project ID), one Query per page with strong hydration, so pages are full. `projects.put` writes the attributes with the entity-list pair and a change of organization rewrites them. The Terraform module derives GSIs and IAM index ARNs from `indexes.json`, so adding the entry (and the 11 to 12 count in the tftest) is the whole infra change; adding a GSI to an existing table is an online update.
- Backfill: projects written before the index existed are invisible to `listByOrg` until `DynamoStore.backfillProjectOrgIndexes()` runs once (pages the global project index, no scan; revision-fenced; idempotent; needs table `GetItem`, `UpdateItem` and index `Query`). Run it after the GSI finishes backfilling. The emulated suite covers it (winterbaume ran: 37 passed).


## 2026-11-25 — Review of the M5 follow-ups

- Reviewed by Claude Opus; implemented by Claude Sonnet. Accepted: the bundle-cleanup cursor as one blob (round-robin laps, restart on corrupt or stale cursors), and the sparse `project-org` GSI with a one-off `backfillProjectOrgIndexes()` for tables created before it (pages the project index, no scan; run after the GSI finishes building).
- Accepted with a follow-up: the cron role gained bucket-wide blob `write` (PutObject on the primary bucket). It already held bucket-wide delete, so the widening is modest, but requirement rows cannot scope a key prefix yet (TODO). Choosing blob over KV kept the per-topic cron role within the inline policy budget guard.

## 2026-11-25 — M4i (Terraform): S3 Tables module and the archive-iceberg infra descriptor

- Table creation: Terraform owns the table bucket and namespace only. The `events` table stays with the engine's `ensureTable` because a Terraform `aws_s3tables_table` takes a schema but no format version, partition spec or sort order (D3, D13); adopting a Terraform-made table would lose the layout. Consequence found in the provider schema (6.32.1 and 6.73.0 identical): bucket-level `maintenance_configuration` covers only `iceberg_unreferenced_file_removal`; compaction and snapshot management are table-level, so they cannot be set without owning the table. The module validates them (compaction 64 to 512 MB, 1 hour and 1 snapshot minimums) and exports them as `table_maintenance`; applying them is `TODO(M4l)`. Defaults are the S3 Tables defaults (3 / 10 days, 512 MB auto, 120 hours); the documented minimums are accepted and tested.
- Grants: `read` (api and everything else) is GetTableBucket, ListNamespaces, GetNamespace, ListTables on the bucket and GetTable, GetTableMetadataLocation, GetTableData on `<bucket>/table/*`; `write` adds CreateTable, PutTableData, UpdateTableMetadataLocation; `delete` is PutTableData plus UpdateTableMetadataLocation, because a row delete (deletion vector) and a snapshot expiry are metadata commits. No role gets DeleteTable, DeleteNamespace, DeleteTableBucket, policy or maintenance actions (a test pins that). `CreateTable` is on the bucket and the table prefix and the action list is derived from the spike's CloudTrail plus the AWS Iceberg REST documentation; neither was exercised under least privilege, so M4m must verify it. KMS: with `aws:kms` the policies add `kms:Decrypt` (read) or Decrypt plus GenerateDataKey (write, delete) on the key; the key policy for the S3 Tables maintenance principal is the operator's.
- Descriptor: `infra` is now the AWS descriptor; `localInfra` is the old placeholder (standalone). `icebergArchive(config, { existing })` selects `localInfra`, or `infra` when `existing` is given, because a validated AWS stack needs an IAM policy per archive capability and `existing` is the only way to supply them without a module (`existing` must carry `table_bucket_arn`, `catalog_uri`, `region`, `policies`). `s3TablesArchive({ region, ... })` builds a sigv4 / `s3_tables` config. Warehouse, catalog URI and the sigv4 region reach the function as `ERRTRAQ_ARCHIVE_WAREHOUSE`, `ERRTRAQ_ARCHIVE_CATALOG_URI` and `ERRTRAQ_ARCHIVE_REGION` environment bindings, and `create` lets them override the config (`applyEnvironmentBindings`), so the module output is the single source of truth and the table bucket ARN need not be known at config time. The requirement rows already resolve the archive grants to `consumer` and `cron` (read, write, delete) and `api` (read), so the future `archive` role only has to join the role set.
- Verified by `stacks/aws-s3tables-archive.test.ts`: the generated root wires `module.archive` policies into those roles only, and the descriptor, HCL outputs, variables and shape snapshot agree. The `s3tables-archive` root fixture runs `terraform validate` and the mock test on both pinned provider versions.
- Unverified: the TLS-deny table bucket policy (`Deny` on `s3tables:*` with `aws:SecureTransport`) passes mock tests only; AWS may reject an `s3tables:*` wildcard in a table bucket policy. No account was touched.
- Implemented by Claude Sonnet; review by Claude Opus pending.


## 2026-11-25 — Review of the M4i Terraform piece

- Reviewed by Claude Opus; implemented by Claude Sonnet. Accepted: `infra/modules/aws/s3tables` (table bucket, namespace, TLS-only bucket policy, unreferenced-file removal), per-capability policies that grant no drop, policy or maintenance action to any function role, and the decision that Terraform does not create the `events` table (the provider resource cannot express format v3, the partition spec or the sort order, so `ensureTable` keeps it and table-level maintenance becomes an M4l engine/operator step).
- The descriptor injects the table bucket ARN, catalog URI and region as environment bindings applied over the config at `create`, so a stack does not need the ARN at config time.
- Merged after the M5 per-organization index change; `pnpm infra:validate` passed on the combined main (22 generated root variants at both pinned provider versions). The IAM action list is still unverified against a real least-privilege role (M4m TODO).

## 2026-11-25 — M4i: the archive role, the container image and the AWS wiring

- Role and routing (D6). `archive` is the seventh role and always split (`ALWAYS_SPLIT_ROLES`). Validation adds it to the platform roles when an archive is selected on a function platform (the way grouped recording adds `record`) with the defaults 300 s timeout and 1024 MB; naming it without an archive is an error. Routing is platform-dependent: `TOPIC_ROUTES["archive.project"]` keeps `consumer` for the single-process platform and has a `deployed` entry (`archive` produces and consumes) used when `platform.compute === "function"` (`topicRoute()`); `CRON_JOBS` entries gained `archiveRole` and `cronJobRole()` picks it when an archive is selected on a function platform. Standalone behaviour is untouched (M4g and M4h tests unchanged).
- Requirement rows. Archive rows exist for `archive` (store read/write/delete, primary blob read/write/delete/list, archive read/write/delete) and `api` (archive read) only. The old `consumer` and `cron` archive rows, the `staging` blob rows (D5) and both archive KV rows (consumer read, cron write) are gone: nothing in the worker, planner or housekeeping uses KV. Without an `archive` role (standalone) the rows simply do not apply and no IAM is derived.
- Found: `archive-overflow/` batch manifests could not have worked on AWS. The worker `put`s and `list`s them in the primary blob store, but neither the S3 module's primary prefixes (`envelopes/`, `payloads/`, `artifacts/`) nor the blob-s3 runtime allow-list included the prefix, so the first overflow batch would have been denied. Both now include `archive-overflow/` (the staging purpose, its prefix, lifecycle rule, `staging_arn` output, bindings and runtime handling were removed). Consequence recorded in TODO: every role with primary write can write that prefix.
- Queue constraint. One physical queue has one event-source mapping, so a queue carrying `archive.project` and `ingest` cannot serve two functions. Validation now rejects a function-platform queue whose topics are consumed by different functions ("use a per-topic queue"); the SQS `archive_project` queue defaults to batch size 1, maximum concurrency 5 and visibility 1800 s (six times the 300 s timeout; the worker stops starting batches at 60% of its `archiveInvocationTimeoutMs`, which the generated entry sets from the function timeout, and continues through a message to itself). `visibilityTimeoutSec` and the function timeout are validated together as before.
- Cron placement. `archive-planner` and `retention` (with the archive housekeeping, `archiveRetentionDays` from the deployed plan) run on `archive`. `erasure-worker` is no longer scheduled on function platforms (it was, with a "not implemented" handler, before): `TODO(M4j)`. `retention` without an archive is unchanged: not scheduled on function platforms, because the cron role lacks the store and blob grants; recorded in TODO rather than decided here. The Lambda handler hosts a job only when its role is held (`hostedJobs`), so the archive function ignores `staged-recovery` and the cron function ignores archive jobs.
- `archiveRetentionDays` moved to `StackConfig` (zod root schema, validated against an archive, `DeployedPlan`, `CreateContext` for the standalone platform). The standalone platform key still works and the stack-level value wins.
- Packaging. The `archive` role and any function with an archive grant (`api`) are image functions (`isImageFunction`); validation requires `api` to be split when an archive is selected. One image holds every image function's bundle under `<function id>/index.mjs`; each Lambda function sets its image command to `<id>/index.handler`, so there is a single repository, image and `image_uri`. The platform config takes `imageUri` (required exactly when an image function exists: the descriptor throws at `resolveStack`, which surfaced as a `platform.infra.inputs` validation error in fixtures that selected an archive without it), `imageArchitecture` (default arm64; a conflicting per-role `architecture` is rejected) and `settings.<role>.ephemeralStorageMb` (default 2048 MB for image functions, 1024 MB memory). The `lambda-app` module creates the ECR repository (immutable tags, scan on push, AES256, keep-last-30 lifecycle, repository policy for `lambda.amazonaws.com` with `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` and an `aws:sourceArn` condition for this stack's function names) and exposes `image_repository_url`. A function cannot be created before its image exists, so the operator applies the repository first (TODO).
- Build. `errtraq build` writes `Dockerfile` and `duckdb-extensions.mjs` into the output directory for AWS stacks with image functions and removes them again if the archive is dropped. The script installs `httpfs`, `avro` and `iceberg` through DuckDB itself into `/opt/errtraq/duckdb-extensions` (the layout `v2.0.1/linux_arm64/` follows the binding's version and platform, so no hard-coded URL or version) and then `LOAD`s them with autoinstall and autoload off; `s3TablesArchive` defaults the engine to `extensionMode: "preinstalled"`, that directory, `memoryLimit: "704MB"` and two threads. The bundle externalises `@duckdb/*` for every AWS function of an `archive-iceberg` stack but only image functions import the engine. The generated entry builds adapters lazily on the first invocation (existing `retryableInitialization`), not at module init as the spike suggested.
- Credentials. `lambdaAwsCredentials(process.env)` is the `awsCredentials` binding the entry passes to the archive adapter (needed by the SigV4 catalog client and the S3 secret); it reads `AWS_*` on every call and sets `expiration` only when `AWS_CREDENTIAL_EXPIRATION` is present, because Lambda publishes none. `constructDeployedPlan` gained an `extraBindings` hook (like `constructStack`).
- Local image smoke (Docker 29, arm64 host, nothing pushed). `docker build --platform linux/arm64` of the generated context succeeded (base `public.ecr.aws/lambda/nodejs:26`, install then load of the three extensions in about 3.6 s, image 231 MB). With `--network none`, instance options as the engine sets them (`extension_directory`, autoinstall and autoload false, `memory_limit` 704MB, two threads), `LOAD httpfs`, `LOAD avro` and `LOAD iceberg` all succeeded (DuckDB v2.0.1, platform `linux_arm64`, 42 `iceberg*` functions), `LOAD aws` failed with "not found" instead of reaching out, and both bundles import. Through the Lambda runtime interface emulator in the image, `archive/index.handler` without bindings failed with the expected `Missing deployed binding ERRTRAQ_ARCHIVE_WAREHOUSE`, and with fake bindings and credentials it constructed the whole archive function (DynamoDB store, S3, SQS, the DuckDB-backed archive store) and acknowledged an unknown job. Not checked: any real AWS call, cold start on Lambda, `/tmp` pressure.
- Tests and fixtures. Core stack tests got a `withArchive` fixture helper (an archive on the function-platform fixture needs a per-topic queue and a 1800 s visibility for the archive queue) and tests for the role, rows, routing, cron placement and rejections; `infra-examples.test.ts` and INFRA_MODEL.md now keep the shared example archive-less. New: handler tests for the archive role, `lambdaAwsCredentials`, SQS archive settings, `stacks/aws-dynamodb-archive.test.ts`, CLI build tests (image layout, cleanup on rebuild), an infra-gen snapshot, root fixture `dynamodb-archive` (23 variants at both provider versions) and module tftest runs for image functions (8 runs; `terraform test` for lambda-app is now 22 runs). 12 module and 6 generated-root mutations were added (ECR principal, actions and source condition, mutable tags, scan off, image command, ephemeral size, image URI scoping, unexposed archive role, `archive-overflow/` prefix, and root mutations for archive grants on the consumer, a dropped archive policy, the archive queue on the consumer, retention on cron, a dropped image URI and an archive binding on ingest).
- Emulator. See WINTERBAUME_GAPS.md: no ECR, so only ZIP parts were probed; results there.
- Left open (TODO): M4m live verification list, two-step image apply, lazy engine init versus module init, the `archive-overflow/` grant breadth, `retention` without an archive, and the bucket naming question (not changed).
- Implemented by Claude Sonnet; review by Claude Opus pending.

## 2026-11-26 — Review of M4i (archive role, image packaging, AWS wiring)

- Reviewed by Claude Opus; implemented by Claude Sonnet. Accepted: the always-split `archive` role (only with an archive selected), the deployed route of `archive.project` to it, the requirement rows reduced to `archive` and `api` (staging and archive KV rows removed), the per-topic queue requirement for archive stacks, one arm64 image holding every image function's bundle, ECR pull limited to this stack's functions by `aws:sourceArn`, extensions baked and loadable with networking disabled.
- Fixed in the slice and worth remembering: the `archive-overflow/` manifest prefix was missing from both the module grants and the blob-s3 allow-list, so the first overflow batch on AWS would have been denied. The fix widens primary write to that prefix for every role with primary write (TODO).
- Open: everything AWS-side is unverified (M4m); the emulated `generated-root` probe timed out twice and was not compared against the previous commit; the bucket naming question stays with the owner.
- Housekeeping note: ten `terraform-provider-aws` processes from an earlier mutation run (in a removed worktree, reparented to init) were found running and stopped.

## 2026-11-26 — G0/G1: gcp-auth and blob-gcs

- Design: `packages/gcp-auth` is fetch plus WebCrypto only (Workers-compatible, added to the layering allow-list next to `aws-signing`). `TokenSource.getAccessToken(scopes)` and `getIdToken(audience)` over the metadata server (host overridable, the `Metadata-Flavor` header, `identity?audience=...&format=full`), a service account JSON key (RS256 JWT bearer grant, also `target_audience` ID tokens), static and none (an empty access token means no Authorization header, emulators only). One `TokenCache` gives per-scope-set keys, a 60 s expiry skew, single-flight refresh and no caching of failures. Errors carry a code (`unavailable`, `denied`, `bad_key`, `bad_response`) and never include key material or response bodies. `BlobSigner` is implemented twice: locally by the key source (GCS V4 is plain RSA-SHA256 over the string to sign, so a key needs no network) and by `IamSigner` through IAM Credentials `signBlob`. `verifyGoogleIdToken` checks RS256 only (rejects `none` and HS256), `kid` against a `GoogleKeyStore` (JWKS cached by `max-age`, refetch for an unknown `kid` at most once per 60 s), `iss`, `aud` (string or array), `exp`, `nbf`, `iat`, a subject, and optionally `email` plus `email_verified`.
- blob-gcs behaviour: `put` of bytes is a simple media upload (unconditional overwrite, retry-safe); streams buffer one 8 MiB chunk (multiple of 256 KiB), and a stream that ends inside the first chunk is sent as media, otherwise a resumable session is used with non-final `bytes a-b/*` chunks and a final range with the known total (an empty final range `bytes */N` when the stream ends on a boundary). A failed chunk asks the session for its persisted offset and resends the rest from the buffer. The session URI must share the endpoint's origin (rewritten only when an endpoint override is configured, because emulators advertise their own host), and session requests carry no bearer token. `get` uses `alt=media` with `Accept-Encoding: identity`, verifies length and, for whole-object reads, the `x-goog-hash` crc32c (mismatch raises `BlobCorruptError` at end of stream); `head` is a metadata GET (`fields=size,contentType`), not an HTTP HEAD, so the error body is available; `list` asks GCS for exactly the keys still wanted per page so the GCS `nextPageToken` is the port's opaque cursor (scoped by prefix through `encodeCursor`); `delete` treats 404 as success. Retries (network, 408, 429, 5xx, five attempts, jittered backoff, overall deadline) apply only to idempotent calls. Presign is V4 `GOOG4-RSA-SHA256`, path-style host, `UNSIGNED-PAYLOAD`, `host` as the only signed header, credential scope `auto`, at most 7 days; `presign` exists only when a signer is available (not for `static` and `none`).
- Preconditions: `blobStoreContract` has no create-only case and the port's `put` is an unconditional overwrite, so the adapter sends no `ifGenerationMatch`. A create-only API would need a port change first. The spike below confirms the emulator would support it.
- Config decisions: `location` is required with no default (D7); `auth` is a union `metadata | service-account { keySecretId } | static { tokenEnv } | none`, `none` requires an `endpoint` override; the service account key is read through the `SecretSource` on first use only. Bindings mirror blob-s3 (`ERRTRAQ_BLOB_BUCKET`, `ERRTRAQ_STAGING_BUCKET`, `ERRTRAQ_STAGING_PREFIX`). The descriptor references `gcp/gcs` with `TODO(G6)`; the module does not exist, and `pnpm lint` and `pnpm test` do not need it.
- Emulator spike (D6): `fsouza/fake-gcs-server:1.56.1`, digest `sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef`, container `errtraq-g1-gcs`, run with `-scheme http -external-url -public-host` set to the host port. Results: `blobStoreContract` passes (7 cases, including UTF-8 key ordering and cursor rejection); multi-chunk resumable upload (256 KiB chunks), empty stream, ranged read and a 1105-key listing over page boundaries pass. Probes: `ifGenerationMatch=0` on media upload gives 200 then 412 `conditionNotMet`, a wrong generation gives 412; `ifGenerationMatch` on DELETE is ignored (deleted anyway); a download carries `X-Goog-Hash: crc32c=...,md5=...` and ranges answer 206 with `Content-Range`, past the end 416; session `Location` is built from the request Host; cancelling a session answers 499. Gaps: a missing bucket and a missing object both answer a bare `{"message":"Not Found"}` 404 (the adapter's bucket-versus-object split, which reads the message, cannot be exercised; real GCS wording is a G8 item); a status query (`Content-Range: bytes */*`) finalizes the upload and returns 200 instead of 308, so chunk recovery is tested only against the fetch fake. `storage-testbench` was not needed. The container was removed afterwards; the image stays in the local Docker cache. Under Colima the host port forward died mid-run once (load, not the emulator): the opt-in test caps its put concurrency at 25 and an SSH tunnel to the VM port restored access.
- The harness is `scripts/gcs-emulated/run.mjs` (`pnpm test:gcs-emulated`): pinned image, free host port, always removes the container. It could not be run end to end in this session because the host Docker socket was down at that moment (the emulated test itself was run against the same image by hand); run it once before relying on it.
- Verified: `pnpm typecheck`, `pnpm lint` (layering, exports, Workers bundle of `gcp-auth` and `blob-gcs/runtime`), `pnpm test` offline, and the emulated suite above.
- Implemented by Claude Sonnet; review by Claude Opus pending.


## 2026-11-26 — Review of G0/G1 (gcp-auth, blob-gcs)

- Reviewed by Claude Opus; implemented by Claude Sonnet. Accepted: token sources with a shared cache contract, RS256-only Google ID token verification with a JWKS cache, local and `signBlob` V4 signing, resumable uploads with offset recovery, crc32c verification on whole-object reads, no default location (D7).
- Changed in review: `blob-gcs` had copied blob-s3's `staging` purpose (bindings, module inputs and outputs, prefix checks). M4 dropped staging, and M4i removed it from blob-s3, so it is gone here too; the runtime allow-list now matches blob-s3 (`envelopes/`, `payloads/`, `artifacts/`, `archive-overflow/`).
- Open: `pnpm test:gcs-emulated` itself was never run end to end (Docker went down; the emulated tests ran by hand through a tunnel into the Colima VM, which the orchestrator then asked agents not to repeat). Run it once when Docker is back.
- Open for G5: core requires a module's provider source to end in `/<module.provider>`, so modules under `infra/modules/gcp` cannot validate against `hashicorp/google` (found in G4). Either map the provider family in core or name the module directory `google`.

## 2026-11-26 — G4: Cloud SQL for PostgreSQL mode in store-sql

- Implemented by Claude Sonnet, reviewed by Claude Opus. `postgres({ mode: "cloudsql-iam", instanceConnectionName, region, database, serviceAccountEmail?, connection?, adminSecret? })`; the transport and the token source sit behind two seams in `postgres-cloudsql.ts` (`cloudSqlTransport`, the `accessToken` function).
- Documented facts (Cloud SQL pages fetched 2026-11-26): the IAM database user of a service account is its email without `.gserviceaccount.com` (it must be omitted because of the username length limit); the password is an OAuth 2.0 access token; `roles/cloudsql.instanceUser` carries the login permission and `roles/cloudsql.client` the proxy connect permission; Cloud Run mounts `/cloudsql/<project:region:instance>`, the PostgreSQL socket file `.s.PGSQL.5432` is inside it, the socket is encrypted by the platform (clients disable TLS), socket paths over 108 characters fail, and an instance accepts at most 100 connections per Cloud Run instance. Server CA modes: per-instance CA (verifying the CA verifies the server), shared CA and customer-managed CA (the DNS name must be checked too; the certificate carries the instance DNS name). The pages do not name the login token scope; `https://www.googleapis.com/auth/sqlservice.login` is the value the connectors use (confirm in G8).
- IAM users are created through the Cloud SQL Admin API (Terraform `google_sql_user`), not `create role`, so the Cloud SQL admin flavor never creates the role (`ROLE_MISSING` when it is absent), never grants `rds_iam`, and only grants the schema and table privileges. The administrator is a built-in `cloudsqlsuperuser` user whose `{username,password}` JSON sits in Secret Manager; whether `cloudsqlsuperuser` may grant on objects owned by other users is for G8.
- A Cloud SQL IAM user is one per service account, but the plan gives each function its own service account. The selection therefore lets the runtime derive its user from its own identity when `serviceAccountEmail` is omitted; the SQL grants then have to exist for every function account (open item for G5).
- The TCP form pins the server CA with `rejectUnauthorized: true`. Without `serverName` only the hostname comparison is skipped (the certificate does not name the private IP), which is sound for a per-instance CA only; with `serverName` the standard check runs against that DNS name.
- Core constraint found: provider validation requires `source` to end in `/<module.provider>`, so the descriptor's `gcp` provider validates only against a placeholder source; `hashicorp/google` needs a family map in G5 or a `google` module directory.
- Opt-in test design: Docker runs in a VM, so a unix socket cannot be shared with the host. `scripts/test-postgres-cloudsql.mjs` bundles `postgres-cloudsql.socket-driver.ts` with esbuild (resolved through vitest and vite) and runs it in a `node:22-alpine` container that shares a volume with the Postgres container's socket directory (`PGHOST` must point at the relocated socket for the image's init-time psql). Password authentication stands in for IAM.

