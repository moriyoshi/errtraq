# Project To-Dos

Items extracted from JOURNAL.md during `good-sleep` consolidation, plus open follow-ups. Each
item should be resolved or removed once addressed. Milestone work itself is tracked in the
"Milestones" section of ARCHITECTURE.md, not here.

## Open Items

- [x] M3 remaining queue item 0: reconcile completed M3 entries and cite their commits; keep
  direct-mode contention and real-AWS verification open.
- [x] M3 remaining queue: items 1-8 are implemented (item 3 as lifecycle-rule blob cleanup,
  b685a35); event TTL activation is deferred to M4 with archival. Item 9 is a design note only,
  `.agents-docs/M3_PACKAGING_DESIGN.md`; its implementation is the packaging item below. Real-AWS
  M3h work remains with the orchestrator.

- [x] M3 issue-keyed recording: require explicit grouped-recording and queue grouping capabilities, remove the temporary optional method fallback, and use one `RoutedTopic` type. Store adapters and the FIFO record pipeline were implemented in 35428f7, 91c4d4b and 2e506b9. — *source: issue-keyed turn 2*
- [ ] M4: activate the event `ttlEpoch` backstop with the archiver; explicit retention deletes remain primary. `ttl-backstop.ts` now calculates epoch seconds with safe later rounding, but is not wired into writes. Do not set TTL before archival commit when archive is enabled; settle and durably enforce the retention ceiling / retention-increase and archive-transition policy before enabling it. — *source: store review section C*
- [x] M3e: narrow the ingest store policy to `GetItem` on `KEY|*` through a separate `key-read` capability. — *source: store review section C*
- [x] M3e: provide a conditional, idempotent backfill for legacy bundle release and expiry indexes using an explicit operator-supplied inventory; existing records are not automatically discovered. — *source: store review section C*
- [ ] M3e: provide a source for a complete legacy bundle inventory and run the backfill where needed; the backfill intentionally does not scan the table. — *source: M3 item 4*
- [x] M3e: resolve the pending bundle and manifest TTL decision: no TTL; scheduled, monitored cleanup is required. — *source: owner decision after store review*
- [ ] M3h / direct mode: verify the retry policy and hot-issue limits on real DynamoDB; the 500 ms jitter cap did not eliminate exhaustion in DynamoDB Local (58.55 attempts per event and 213 failures at 500 writers). The grouped FIFO path and local contention measurement are implemented (35428f7, 91c4d4b, 2e506b9, 8573aa2). — *source: store review section B*
- [x] M3f2 part 2: add the RDS IAM policy module and contract / mutation tests, Lambda VPC configuration and ENI grants, and Postgres-on-Lambda generated-root and emulator coverage. — *source: M3f2 part 1*
- [ ] M3f2: remove the Winterbaume Lambda VPC readback override when a fix for https://github.com/moriyoshi/winterbaume/issues/62 is pinned. — *source: M3f2 part 2*
- [ ] M3h: verify real Lambda-to-RDS/Aurora IAM authentication, the Lambda runtime CA bundle and hostname verification, new connections after 15 minutes, and RDS Proxy IAM/TLS behavior and permissions; verify VPC attachment, ENI role permissions and service reachability through the selected NAT or endpoints. — *source: M3f2*

- [x] M3e / M4: replace the earlier subject-index ledger proposal with the owner-selected inline Parquet index, optional sharded fence and staged port changes. — *source: M3e step 1c*
- [ ] M5: wire bundle upload and pending-bundle cleanup scheduling; activate the appropriate metadata-delete and manifest blob policy rows for the cleanup role when those handlers exist; check that their actual marker keys match the DynamoDB policy namespaces. Manifest object keys must be unique and never reused. — *source: M3e stage 1 step A*
- [ ] M3h: verify exact count-sort key updates under contention on real DynamoDB; the guard and DynamoDB Local concurrency cases are implemented (65399d7, a5bf23b). — *source: M3e step 1c*
- [ ] M4: resolve the main-queue drain proof before claiming erasure completion; waiting and inspecting the DLQ and index cannot prove that a committed, unindexed event is not still retrying in the main queue. Verify blob list/read consistency and lease-fenced manifest operations for the Parquet index. — *source: M3e step 1c*
- [ ] M3h: measure 500 concurrent same-issue writes in both modes, transaction/GSI write units and index backpressure, and verify the revised IAM policies and LeadingKeys restrictions, immutable shard metadata and composite key queries, and measure fence ConditionCheck conflict rates on real AWS. — *source: M3e step 1c*

- [ ] M3h: verify actual SQS throttling status and error codes, U+FFFE / U+FFFF rejection, 1 MiB message-size support, receive-count increments and DLQ redrive timing against AWS. — *source: M3c2 review section B*
- [ ] M3h: capture scrubbed real Lambda SQS, function URL and EventBridge events as fixtures. — *source: M3c2 review section B*
- [ ] M3h: verify SQS FIFO grouping, high-throughput settings, Lambda partial failures, poison redrive and visibility races on real AWS; the pinned Winterbaume has FIFO gaps. — *source: issue-keyed turn 4*

- [ ] M3h: verify DynamoDB conditional update atomicity, expiry-reset races, overflow guards and TTL retention against real AWS; Winterbaume evaluates conditions separately from its write. — *source: M3d emulator finding*

- [ ] M3h: verify real S3 behavior for unsigned payloads over HTTP, URL-encoded listing spaces and plus signs, 403-versus-missing under the scoped read policy, and multipart-abort permissions. — *source: M3b review section B*
- [ ] M3h / security: review the pinned `aws4fetch` 1.0.20 signing dependency; it is small and WebCrypto-compatible but has not been independently audited. — *source: M3b review section B*

- [x] M3 / M6: define and enforce portable BlobStore key rules, including empty and `.` / `..` segments. — *source: M3b; resolved in M3b2*
- [ ] M3: replace the local S3 UTF-8 decoder patch when Winterbaume fixes the new percent-decoding gap upstream. — *source: M3b*
- [x] M3a2: add the local real-provider generated-root harness with API assertions, named gap checks, repeat and change plans, and destroy inventories. — *source: M3a2 provider probe*
- [ ] M4 spike: confirm DuckDB iceberg-extension appends through a REST catalog against Lakekeeper and S3 Tables, and what Cloudflare Workers can do against R2 Data Catalog. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M4 spike: determine which engines can write and honor Iceberg v3 deletion vectors through a REST catalog; decide whether the native committer is needed. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [x] M3: probe Winterbaume DynamoDB and SQS against the planned adapter operations; no tested gap requires DynamoDB Local or ElasticMQ. Continue checking the real adapter contract suites in M3. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions; M3a probes*
- [ ] M1: define indexed tag-key discovery and issue tag-filter semantics before exposing tag filters through active-store adapters. — *source: JOURNAL 2026-11-21 — M0c: contract harness and memory semantics*
- [x] M1: design crash-safe coordination of event insertion and issue occurrence updates; an inserted flag alone cannot make both operations atomic. — *source: JOURNAL 2026-11-21 — M0c review: delivery, scan and pagination contracts*
- [x] M1: allocate project IDs as decimal-digit strings for Sentry-compatible DSNs. — *source: M0d final review A6*
- [ ] M4: prevent stale lease holders overwriting staging batches, using a nonce in staged keys or conditional blob writes. — *source: M0d final review B*
- [x] M1: `tsconfig.tests.json` type-checks every package with WebWorker libs and no Node types; Node-only adapter and platform packages (for example `store-sql` sqlite, `blob-fs`, `standalone`) need their own lib / types settings without loosening `core` and `http`. — *source: JOURNAL 2026-11-21 — M0 closed: final review, verification and research*
- [ ] M4: act on `.agents-docs/M4_ICEBERG_SPIKE_RESEARCH.md`: the Athena query engine cannot read v3 tables, winterbaume has no Docker image (compose must run the binary), Lakekeeper needs `sts-enabled: false` against winterbaume, and Cloudflare has no verified in-process write path. Revise the "ArchiveStore" engine list in ARCHITECTURE.md once the hands-on spikes report. — *source: JOURNAL 2026-11-21 — M0 closed: final review, verification and research*
- [x] M1d: make concurrent bootstrap of the same organization/project slug safe across processes and use cryptographically secure DSN keys. — *source: JOURNAL 2026-11-21 — M1c ingest pipeline; resolved in M1f*
- [x] M1d: configure the consumer envelope size limit consistently with the ingest service. — *source: JOURNAL 2026-11-21 — M1c ingest pipeline*
- [ ] M4 or retention slice: remove orphaned raw envelope and overflow blobs after crashes between pipeline steps. — *source: M1f review section B*
- [ ] M5: if snapshot-consistent issue pagination becomes a product requirement, add persistent snapshots or versioned history. M1 uses stateless keyset cursors, so concurrent sort-key changes can move rows across a cursor. — *source: JOURNAL 2026-11-21 — M1e adapter review fixes*
- [ ] Before adding a MySQL SQL dialect, implement its index-creation syntax without `CREATE INDEX IF NOT EXISTS`, changed-row versus matched-row semantics, type / collation choices and conflict syntax; the M3f hooks and Postgres / SQLite implementations do not establish MySQL behavior. — *source: M1e review section B; narrowed by M3f*
- [x] M3 / Postgres: reconcile the 255-character indexed-column limit (including serialized composite keys) with the currently unbounded port identifiers; add explicit input validation or a reviewed key representation before relying on arbitrary-length values. — *source: M3f; resolved by the shared core `withIdentifierLimits` rule*
- [ ] M4: investigate raw-deflate clients; Web DecompressionStream accepts zlib-framed deflate, and raw deflate currently returns 400. — *source: M1f review section B*
- [x] M3: provide token management for non-local deployments (`errtraq token list|revoke`, `ProjectRepo.listTokens` / `revokeToken`). Remaining: token creation / rotation for deployed stacks (only the bootstrap token exists; list and revoke verified on real DynamoDB in the second M3h run, RDS pending). — *source: JOURNAL 2026-11-21 — M1d local stack; resolved 2026-11-24*
- [ ] M4: decide the physical-erasure (`hardErase`) path for v3 tables: DuckDB 2.0 cannot rewrite v3 data files. First test whether S3 Tables / Lakekeeper maintenance actually applies deletion vectors over a longer window; otherwise copy-forward, format v2, or a native rewrite. — *source: `.agents-docs/S3TABLES_DV_SPIKE.md`*
- [ ] M4: the DuckDB archive engine must set `iceberg_use_metadata_log = false` (or re-attach per operation) and retry commit conflicts; package the Lambda archive function as a container image with extensions baked in, `home_directory` under `/tmp`, env-based S3 secret. — *source: `.agents-docs/S3TABLES_DV_SPIKE.md`, `.agents-docs/DUCKDB_LAMBDA_SPIKE.md`*
- [ ] M4: untested by the spikes: Iceberg reads and writes from inside Lambda, Lakekeeper with winterbaume as its object store, Athena / Spark as readers, least-privilege IAM for S3 Tables. — *source: spike reports*
- [ ] M5 / UI: add per-project issue short IDs, actual distinct-user counts, and numeric-looking issue IDs if a client requires them; implement statsPeriod statistics and indexed environment and free-text filters. — *source: M1g closing review section B*
- [ ] CI: run the Python SDK end-to-end check required by ARCHITECTURE.md once a Python environment is available. — *source: M1g closing review section B*
- [x] M3: provide indexed token enumeration and revocation for tokens issued before M1g. SQL backfills in migration 5; DynamoDB tokens written before the org index are revocable by ID at once and become listable when rewritten (`errtraq bootstrap` rerun, or revocation). Local `token rotate` still revokes only the file-backed token. — *source: M1g closing review; resolved 2026-11-24*

- [x] M3: integrate the AWS Secrets Manager runtime secret source for deployed Lambda functions. — *source: M2a2 review A4; M3g part 1*
- [ ] M3h: verify deployed CLI bootstrap against real Secrets Manager, DynamoDB and RDS, including IAM/KMS permissions, network reachability and recovery after an interrupted first run. — *source: M3g bootstrap*

- [x] M3: enforce the 1 MiB SQS body limit including serialization and envelope overhead. — *source: M2b step 1; resolved in M3c*
- [ ] M4: implement DynamoDB subject-erasure semantics; the M3 AWS runtime adapters are implemented (dcf7ff6, 121ff53, 240a355, a5bf23b). — *source: M2b step 1*

- [x] M3: implement SQS partial batch failures. — *source: M2b step 2; resolved in M3c*
- [x] M3: add documented real-shaped EventBridge event fixtures and verify dispatch (packages/platforms/aws-lambda/src/aws-events.test.ts); the recovery job and generated Lambda wiring are implemented (8573aa2). — *source: M2b step 2*
- [x] M3e: implement and test stage 1 of the DynamoDB layout, module and policies (43e1904, a5bf23b, fa089e4); subject erasure remains M4. — *source: M2b step 2; revised M3e step 1c*

- [ ] M3 / M6: address second-review follow-ups N9 and N12-N15, including Cloudflare binding authorization and runtime limitations. — *source: `.agents-workspace/tmp/m2a2-review-fixes.md`*

- [ ] M3h / M4: verify the implemented sortable encodings, projections, sharding and transaction limits on AWS (43e1904, a5bf23b); document PITR retention of erased data for up to 35 days with M4 erasure. — *source: M2b HCL review section B; M3e step 1c*
- [x] M3: require the full Secrets Manager ARN including its random suffix. — *source: M2b HCL review section B; M3g part 1*
- [x] M3: never map an S3 403 directly to missing; use an authorized exact-prefix list to establish absence and propagate real access failures. — *source: M2b HCL review section B*
- [x] M3: schedule cron-based staged-envelope recovery for deployed stacks; keep idempotency and a recovery window longer than the sweep interval. — *source: M2b HCL review A3*
- [x] M3: overflow payloads are deleted with retained events and orphans expire by lifecycle at the longest retention plus a margin; archive / erasure hooks remain M4 (see above). — *source: M2b HCL review A9*
- [x] M3: avoid duplicate Lambda Function URL and ingest app CORS headers, and support S3-based deployment for ZIPs too large for direct upload. — *source: M2b HCL review A8*

- [x] M3: investigate the intermittent missing staged-blob log observed during e2e recovery; determine whether recovery races the consumer deleting an envelope, and verify that the race is safe and correctly logged. A later M2d e2e also logged `Skipping unreadable blob` with `ENOENT`. — *source: M2b HCL contract validation e2e; M2d final gate*

- [x] M3 / packaging (implemented; `pnpm verify:packaging` passes; actual publishing remains an owner decision): support projects that depend on errtraq packages without requiring a `pnpm-workspace.yaml` repository or in-repository build and output directories. Design: `.agents-docs/M3_PACKAGING_DESIGN.md` (project root from the stack file, vendored Terraform modules, published `dist` without the `development` condition, `core` as a peer dependency, a packed-tarball check); publishing details are an owner decision. — *source: M2 final review section B*
- [x] M3: reduce Lambda bundle size by using the runtime-only core entry and minification; Lambda bundles no longer include Zod. — *source: M2 final review section B*
- [x] M3: test SQS partial-batch failures with real-shaped AWS events. — *source: M2 final review section B; resolved in M3c*
- [x] M3: test EventBridge event handling against documented AWS event shapes (real captures remain M3h). — *source: M2 final review section B*
- [x] M3 (store-dynamodb): implement issue-keyed FIFO and measure grouped 200 / 500-event workloads on DynamoDB Local (91c4d4b, 2e506b9, 8573aa2); real AWS measurement remains in the M3h item above. — *source: owner queue-first decision*

- [x] M3: grouped-record claim checks expire through an S3 lifecycle rule (default 30 days, validated above SQS's 14-day maximum retention); a missing claim is poison and redrives to the DLQ. No cron; standalone has no sweep (see `M3_BLOB_CLEANUP_DESIGN.md`). — *source: issue-keyed queue turn 5; M3 queue item 3; resolved in M3 item 3*
- [x] M3: `deleteExpiredEvents` deletes events first and their overflow blobs second; orphans expire through lifecycle rules after the longest retention plus a margin. — *source: M3 queue item 3; resolved in M3 item 3*
- [ ] M4: wire the `retention` cron job to `deleteExpiredEvents` (archived events only when archival is selected) and hand overflow blob keys to the archive and erasure hooks. — *source: M3 item 3*
- [x] M3h (second run, 2026-11-24): real S3 accepts the claim and overflow lifecycle rules, and a missing-claim record redriven from the FIFO DLQ returns to it after five attempts. Actual expiry (days) is not observed. Original item: verify the lifecycle rules (claim and overflow prefixes) and a DLQ redrive after claim expiry against real AWS. — *source: M3 item 3*
- [ ] M3 / product: a project-settings API must validate retention against the stack's `maxEventRetentionDays`. — *source: M3 item 3*

- [x] M3: make the ingest rate limit configurable on the Lambda platform. — *source: M3h first real deployment*
- [ ] M3 / product: decide whether an additional per-project ingest limit is needed alongside the existing per-DSN-key limit. — *source: M3h first real deployment*
- [x] M3h (second run, 2026-11-24): verified. Original item: verify Lambda function URL CORS produces one set of headers for ingest preflight,
  successful responses and errors; verify S3-backed ZIP deployment, update and teardown with an
  operator-owned same-region bucket and its IAM / encryption policy. — *source: M3 item 5*
- [x] Tooling: `pnpm build` (`tsc -b`) left `dist/` older than changed sources without error during the second M3h run. `tsc -b` trusts `.tsbuildinfo` and never checks outputs; `scripts/build.mjs` now verifies every output against its source and force-rebuilds stale projects. — *source: M3h second real deployment*
- [ ] M3h: remaining real-AWS checks: visibility expiry races, mode-switch drain, RDS / Aurora IAM with VPC (needs an operator-built VPC and database; no RDS module exists), provider retries under throttling, FIFO high-throughput attribute readback, and actual lifecycle expiry. Per-topic mode, FIFO poison to DLQ and redrive, token list / revoke, rate rejection, CloudWatch alarm evaluation, missing-data behaviour and SNS delivery were verified in the second run (2026-11-24, JOURNAL). — *source: M3h first and second real deployments*


- [x] M3 CloudWatch alarms (next slice; resolved in M3 alarms): add an alarm for visible DLQ messages greater than zero
  for every enabled standard or FIFO DLQ (`AWS/SQS`, `ApproximateNumberOfMessagesVisible`),
  `AWS/SQS` `ApproximateAgeOfOldestMessage` for every physical source queue, and `AWS/Lambda`
  `Errors` for every physical function. Choose and document useful age / error periods,
  thresholds, evaluation counts and missing-data behavior; set dimensions to the actual queue or
  function names, handle FIFO suffixes and queues with no DLQ, and apply stack tags. Add an
  optional validated operator-supplied SNS topic ARN for alarm actions; no topic or subscriptions
  should be created by default. Thread configuration through the SQS and Lambda descriptors and
  HCL modules without exposing secrets or creating duplicate alarms for shared queues.
- [x] M3 alarm verification (resolved in M3 alarms): extend both Terraform module contract suites with exact alarm count,
  metrics, dimensions, thresholds, periods, missing-data treatment and optional SNS actions; add
  mutations to `scripts/infra-mutations.json` for missing / incorrect alarms and actions. Extend
  `scripts/infra-roots.mjs` mock-provider assertions to derive expected alarms for shared,
  per-topic and grouped roots. Extend `scripts/aws-emulated/terraform-config.mjs` with the
  `cloudwatch` endpoint, then exercise generated grouped roots through emulator apply, API
  readback and destroy. The pinned Winterbaume query probe retained basic alarm fields and SNS
  actions but omitted `TreatMissingData`: see `WINTERBAUME_GAPS.md` and reproduce with the real
  provider before adding a self-verifying named exception. Keep tracked HCL unchanged for any
  emulator limitation. Run the workspace gate, `infra:validate`, `infra:mutate`,
  `test:aws-emulated` and the relevant `infra:apply-emulated` variant.


- [x] M3 stage 3 enforcement and infrastructure: per-issue and new-issue checks, conditional
  KV grants and bindings, platform wiring, enabled generated-root checks and mutation coverage.
  Suppression remains TODO(M4); grouped consumers do not access the store.
- [x] M3 stage 3 issue API: expose approximate current-window dropped counts, with window
  bounds and received-at basis, conditional API KV reads, expiry and fail-open reads.
- [x] M3 remaining queue item 2: aggregate rate-rejection KV failure logging per delivery batch.
- [ ] M3 stage 3 follow-ups: support project-level overrides constrained by stack limits. KV increments can double-charge on retries; the
  received-at bucket intentionally excludes delayed events from the current-window count.
  Preserve privacy-safe logging for retry failures (provider messages may contain secrets), and
  expand integration coverage of retries, project isolation, issue rotation, resolved issues
  and duplicate delivery. KV cost includes one increment per issue/window group and additional
  new-issue and dropped-counter increments; the DynamoDB adapter also reads on increment.

- [x] Test harness: make the `dynamodb-conditional-atomicity` winterbaume gap check in `scripts/aws-emulated/gap-checks.mjs` tolerant of runs where the probabilistic race does not occur (it flaked in 4 of 8 runs on 2026-11-24), e.g. retry the probe several times before declaring the gap gone. Done 2026-11-25: a round reproduces 7-30% of the time, so the probe now runs up to 150 rounds (about 7 s when the gap is gone) and stops at the first reproduction. — *source: M3 queue items 7-8*
