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
