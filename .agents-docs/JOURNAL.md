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
