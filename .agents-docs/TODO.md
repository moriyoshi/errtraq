# Project To-Dos

Items extracted from JOURNAL.md during `good-sleep` consolidation, plus open follow-ups. Each
item should be resolved or removed once addressed. Milestone work itself is tracked in the
"Milestones" section of ARCHITECTURE.md, not here.

## Open Items

- [ ] M3 issue-keyed recording: migrate the remaining adapters, then remove the temporary optional `recordEvents` / grouping capability fallback and unify `CoreTopic` with `RoutedTopic`; wire the record handler and FIFO according to `ISSUE_KEYED_QUEUE_PLAN.md`. — *source: issue-keyed turn 2*
- [ ] M3e: add the event and issue `ttlEpoch` backstops from the DynamoDB design; explicit retention deletes remain primary. The ingest role's read policy also grants table-wide `GetItem`: restricting it with `dynamodb:LeadingKeys` requires a separate capability policy because the current read output is shared with roles that query the whole table. — *source: store review section C*
- [ ] M3e: define an index backfill for bundle records created before the release and expiry index keys were added; existing records are not automatically reindexed. — *source: store review section C*
- [x] M3e: resolve the pending bundle and manifest TTL decision: no TTL; scheduled, monitored cleanup is required. — *source: owner decision after store review*
- [ ] M3e: the 500 ms jitter cap alone did not eliminate hot-issue exhaustion: a DynamoDB Local run with 500 simultaneous, same-timestamp events used 58.55 transaction attempts per event and 213 operations failed; the sampled failure was the 80-attempt contention limit. Implement the selected issue-keyed queue and batched recording; repeat this measurement and verify the retry policy on real DynamoDB before relying on this load. — *source: store review section B*
- [x] M3f2 part 2: add the RDS IAM policy module and contract / mutation tests, Lambda VPC configuration and ENI grants, and Postgres-on-Lambda generated-root and emulator coverage. — *source: M3f2 part 1*
- [ ] M3f2: file the Winterbaume Lambda VPC readback gap upstream and remove the emulator-only override when the fix is pinned. — *source: M3f2 part 2*
- [ ] M3h: verify real Lambda-to-RDS/Aurora IAM authentication, the Lambda runtime CA bundle and hostname verification, new connections after 15 minutes, and RDS Proxy IAM/TLS behavior and permissions; verify VPC attachment, ENI role permissions and service reachability through the selected NAT or endpoints. — *source: M3f2*

- [x] M3e / M4: replace the earlier subject-index ledger proposal with the owner-selected inline Parquet index, optional sharded fence and staged port changes. — *source: M3e step 1c*
- [ ] M5: wire bundle upload and pending-bundle cleanup scheduling; activate the appropriate metadata-delete and manifest blob policy rows for the cleanup role when those handlers exist; check that their actual marker keys match the DynamoDB policy namespaces. Manifest object keys must be unique and never reused. — *source: M3e stage 1 step A*
- [ ] M3e stage 1: verify exact count-sort key updates with the conditional count preimage under contention; the earlier DynamoDB Local concurrency experiment did not exercise that extra guard. — *source: M3e step 1c*
- [ ] M4: resolve the main-queue drain proof before claiming erasure completion; waiting and inspecting the DLQ and index cannot prove that a committed, unindexed event is not still retrying in the main queue. Verify blob list/read consistency and lease-fenced manifest operations for the Parquet index. — *source: M3e step 1c*
- [ ] M3h: measure 500 concurrent same-issue writes in both modes, transaction/GSI write units and index backpressure, and verify the revised IAM policies and LeadingKeys restrictions, immutable shard metadata and composite key queries, and measure fence ConditionCheck conflict rates on real AWS. — *source: M3e step 1c*

- [ ] M3h: verify actual SQS throttling status and error codes, U+FFFE / U+FFFF rejection, 1 MiB message-size support, receive-count increments and DLQ redrive timing against AWS. — *source: M3c2 review section B*
- [ ] M3h: capture scrubbed real Lambda SQS, function URL and EventBridge events as fixtures. — *source: M3c2 review section B*
- [ ] M3: implement SQS FIFO grouped delivery for the issue-keyed record stage, as planned in `.agents-docs/ISSUE_KEYED_QUEUE_PLAN.md`. — *source: owner queue-first decision*

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
- [ ] M3 / Postgres: reconcile the 255-character indexed-column limit (including serialized composite keys) with the currently unbounded port identifiers; add explicit input validation or a reviewed key representation before relying on arbitrary-length values. — *source: M3f*
- [ ] M4: investigate raw-deflate clients; Web DecompressionStream accepts zlib-framed deflate, and raw deflate currently returns 400. — *source: M1f review section B*
- [ ] M3: provide token management for non-local deployments; M1g adds local token reuse and rotation. — *source: JOURNAL 2026-11-21 — M1d local stack*
- [ ] M4: decide the physical-erasure (`hardErase`) path for v3 tables: DuckDB 2.0 cannot rewrite v3 data files. First test whether S3 Tables / Lakekeeper maintenance actually applies deletion vectors over a longer window; otherwise copy-forward, format v2, or a native rewrite. — *source: `.agents-docs/S3TABLES_DV_SPIKE.md`*
- [ ] M4: the DuckDB archive engine must set `iceberg_use_metadata_log = false` (or re-attach per operation) and retry commit conflicts; package the Lambda archive function as a container image with extensions baked in, `home_directory` under `/tmp`, env-based S3 secret. — *source: `.agents-docs/S3TABLES_DV_SPIKE.md`, `.agents-docs/DUCKDB_LAMBDA_SPIKE.md`*
- [ ] M4: untested by the spikes: Iceberg reads and writes from inside Lambda, Lakekeeper with winterbaume as its object store, Athena / Spark as readers, least-privilege IAM for S3 Tables. — *source: spike reports*
- [ ] M5 / UI: add per-project issue short IDs, actual distinct-user counts, and numeric-looking issue IDs if a client requires them; implement statsPeriod statistics and indexed environment and free-text filters. — *source: M1g closing review section B*
- [ ] CI: run the Python SDK end-to-end check required by ARCHITECTURE.md once a Python environment is available. — *source: M1g closing review section B*
- [ ] M3: provide indexed token enumeration and revocation for tokens issued before M1g; their plaintext was not retained, so local token rotation can revoke only the file-backed token. — *source: M1g closing review*

- [x] M3: integrate the AWS Secrets Manager runtime secret source for deployed Lambda functions. — *source: M2a2 review A4; M3g part 1*
- [ ] M3h: verify deployed CLI bootstrap against real Secrets Manager, DynamoDB and RDS, including IAM/KMS permissions, network reachability and recovery after an interrupted first run. — *source: M3g bootstrap*

- [x] M3: enforce the 1 MiB SQS body limit including serialization and envelope overhead. — *source: M2b step 1; resolved in M3c*
- [ ] M3: implement the remaining AWS runtime adapters and make DynamoDB explicit deletion honor erasure semantics. — *source: M2b step 1*

- [x] M3: implement SQS partial batch failures. — *source: M2b step 2; resolved in M3c*
- [ ] M3: verify EventBridge job dispatch with AWS runtime adapters. — *source: M2b step 2*
- [ ] M3e: implement and test the staged DynamoDB layout in `.agents-docs/DYNAMODB_DESIGN.md`, then update the module README and policies; erasure belongs to stage 4. — *source: M2b step 2; revised M3e step 1c*

- [ ] M3 / M6: address second-review follow-ups N9 and N12-N15, including Cloudflare binding authorization and runtime limitations. — *source: `.agents-workspace/tmp/m2a2-review-fixes.md`*

- [ ] M3e / M3h: implement and verify the selected sortable encodings, projections, sharding and transaction limits; document PITR retention of erased data for up to 35 days. — *source: M2b HCL review section B; M3e step 1c*
- [x] M3: require the full Secrets Manager ARN including its random suffix. — *source: M2b HCL review section B; M3g part 1*
- [x] M3: never map an S3 403 directly to missing; use an authorized exact-prefix list to establish absence and propagate real access failures. — *source: M2b HCL review section B*
- [ ] M3: schedule cron-based staged-envelope recovery for deployed stacks; keep idempotency and a recovery window longer than the sweep interval. — *source: M2b HCL review A3*
- [ ] M3 / M4: delete overflow payloads when their corresponding events are retained, archived or erased; a fixed bucket lifecycle would violate per-project retention. — *source: M2b HCL review A9*
- [ ] M3: avoid duplicate Lambda Function URL and ingest app CORS headers, and support S3-based deployment for ZIPs too large for direct upload. — *source: M2b HCL review A8*

- [ ] M3: investigate the intermittent missing staged-blob log observed during e2e recovery; determine whether recovery races the consumer deleting an envelope, and verify that the race is safe and correctly logged. A later M2d e2e also logged `Skipping unreadable blob` with `ENOENT`. — *source: M2b HCL contract validation e2e; M2d final gate*

- [ ] M3 / packaging: support projects that depend on errtraq packages without requiring a `pnpm-workspace.yaml` repository or in-repository build and output directories. — *source: M2 final review section B*
- [ ] M3: reduce Lambda bundle size; current bundles include most of core and Zod. — *source: M2 final review section B*
- [x] M3: test SQS partial-batch failures with real-shaped AWS events. — *source: M2 final review section B; resolved in M3c*
- [ ] M3: test EventBridge event handling against real AWS event shapes. — *source: M2 final review section B*
- [ ] M3 / M3h (store-dynamodb): implement the owner-selected issue-keyed FIFO stage using the completed batched `recordEvents`, then measure 200 / 500 writers through that path on DynamoDB Local and real AWS. — *source: owner queue-first decision*
