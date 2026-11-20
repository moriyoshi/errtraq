# Project To-Dos

Items extracted from JOURNAL.md during `good-sleep` consolidation, plus open follow-ups. Each
item should be resolved or removed once addressed. Milestone work itself is tracked in the
"Milestones" section of ARCHITECTURE.md, not here.

## Open Items

- [ ] M4 spike: confirm DuckDB iceberg-extension appends through a REST catalog against Lakekeeper and S3 Tables, and what Cloudflare Workers can do against R2 Data Catalog. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M4 spike: determine which engines can write and honor Iceberg v3 deletion vectors through a REST catalog; decide whether the native committer is needed. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M3: check whether winterbaume's DynamoDB and SQS coverage is good enough to replace DynamoDB Local and ElasticMQ in the compose file. — *source: JOURNAL 2026-11-21 — Project bootstrap decisions*
- [ ] M1: define indexed tag-key discovery and issue tag-filter semantics before exposing tag filters through active-store adapters. — *source: JOURNAL 2026-11-21 — M0c: contract harness and memory semantics*
- [x] M1: design crash-safe coordination of event insertion and issue occurrence updates; an inserted flag alone cannot make both operations atomic. — *source: JOURNAL 2026-11-21 — M0c review: delivery, scan and pagination contracts*
- [x] M1: allocate project IDs as decimal-digit strings for Sentry-compatible DSNs. — *source: M0d final review A6*
- [ ] M2a: redesign infra references and runtime factory wiring so cross-adapter dependencies can be expressed. — *source: M0d final review B*
- [ ] M2a: expose nested sub-adapter selections so generated entrypoints import only selected engines and catalogs. — *source: M0d final review B*
- [ ] M2a: model grants with resource and policy outputs. — *source: M0d final review B*
- [ ] M2a: map topics to queues, bindings and triggers. — *source: M0d final review B*
- [ ] M2a: name cron jobs on triggers and define ownership of core schedules. — *source: M0d final review B*
- [ ] M2a: model binding type and per-function scope, including secrets and platform bindings. — *source: M0d final review B*
- [ ] M2a: define when environment references resolve (generation, Terraform or runtime). — *source: M0d final review B*
- [ ] M2a: include provider, region and module version configuration. — *source: M0d final review B*
- [ ] M2a: derive deployed function roles from platform configuration rather than a static manifest list. — *source: M0d final review B*
- [ ] M4: prevent stale lease holders overwriting staging batches, using a nonce in staged keys or conditional blob writes. — *source: M0d final review B*
- [x] M1: `tsconfig.tests.json` type-checks every package with WebWorker libs and no Node types; Node-only adapter and platform packages (for example `store-sql` sqlite, `blob-fs`, `standalone`) need their own lib / types settings without loosening `core` and `http`. — *source: JOURNAL 2026-11-21 — M0 closed: final review, verification and research*
- [ ] M4: act on `.agents-docs/M4_ICEBERG_SPIKE_RESEARCH.md`: the Athena query engine cannot read v3 tables, winterbaume has no Docker image (compose must run the binary), Lakekeeper needs `sts-enabled: false` against winterbaume, and Cloudflare has no verified in-process write path. Revise the "ArchiveStore" engine list in ARCHITECTURE.md once the hands-on spikes report. — *source: JOURNAL 2026-11-21 — M0 closed: final review, verification and research*
- [x] M1d: make concurrent bootstrap of the same organization/project slug safe across processes and use cryptographically secure DSN keys. — *source: JOURNAL 2026-11-21 — M1c ingest pipeline; resolved in M1f*
- [x] M1d: configure the consumer envelope size limit consistently with the ingest service. — *source: JOURNAL 2026-11-21 — M1c ingest pipeline*
- [ ] M4 or retention slice: remove orphaned raw envelope and overflow blobs after crashes between pipeline steps. — *source: M1f review section B*
- [ ] M2: if snapshot-consistent issue pagination becomes a product requirement, add persistent snapshots or versioned history. M1 uses stateless keyset cursors, so concurrent sort-key changes can move rows across a cursor. — *source: JOURNAL 2026-11-21 — M1e adapter review fixes*
- [ ] M3: before adding Postgres/MySQL SQL dialects, add JSON and integer-affinity hooks and resolve the unused dialect kind; replace unbounded indexed text and handle MySQL lack of CREATE INDEX IF NOT EXISTS; specify binary collations for keyset parity; and account for MySQL changed-row counts in CAS. The current implementation is validated for SQLite only. — *source: M1e review section B*
- [ ] M4: investigate raw-deflate clients; Web DecompressionStream accepts zlib-framed deflate, and raw deflate currently returns 400. — *source: M1f review section B*
- [ ] M2: provide token rotation and revocation management; the local CLI issues a fresh token on each startup because only hashes are stored. — *source: JOURNAL 2026-11-21 — M1d local stack*
- [ ] M4: decide the physical-erasure (`hardErase`) path for v3 tables: DuckDB 2.0 cannot rewrite v3 data files. First test whether S3 Tables / Lakekeeper maintenance actually applies deletion vectors over a longer window; otherwise copy-forward, format v2, or a native rewrite. — *source: `.agents-docs/S3TABLES_DV_SPIKE.md`*
- [ ] M4: the DuckDB archive engine must set `iceberg_use_metadata_log = false` (or re-attach per operation) and retry commit conflicts; package the Lambda archive function as a container image with extensions baked in, `home_directory` under `/tmp`, env-based S3 secret. — *source: `.agents-docs/S3TABLES_DV_SPIKE.md`, `.agents-docs/DUCKDB_LAMBDA_SPIKE.md`*
- [ ] M4: untested by the spikes: Iceberg reads and writes from inside Lambda, Lakekeeper with winterbaume as its object store, Athena / Spark as readers, least-privilege IAM for S3 Tables. — *source: spike reports*
