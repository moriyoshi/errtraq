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
- [x] M2a: redesign infra references and runtime factory wiring so cross-adapter dependencies can be expressed. — *source: M0d final review B*
- [x] M2a: expose nested sub-adapter selections so generated entrypoints import only selected engines and catalogs. — *source: M0d final review B*
- [x] M2a: model grants with resource and policy outputs. — *source: M0d final review B*
- [x] M2a: map topics to queues, bindings and triggers. — *source: M0d final review B*
- [x] M2a: name cron jobs on triggers and define ownership of core schedules. — *source: M0d final review B*
- [x] M2a: model binding type and per-function scope, including secrets and platform bindings. — *source: M0d final review B*
- [x] M2a: define when environment references resolve (generation, Terraform or runtime). — *source: M0d final review B*
- [x] M2a: configure providers, regions and tags; remove unused module-version metadata. — *source: M0d final review B*
- [x] M2a: derive deployed function roles from platform configuration rather than a static manifest list. — *source: M0d final review B*
- [ ] M4: prevent stale lease holders overwriting staging batches, using a nonce in staged keys or conditional blob writes. — *source: M0d final review B*
- [x] M1: `tsconfig.tests.json` type-checks every package with WebWorker libs and no Node types; Node-only adapter and platform packages (for example `store-sql` sqlite, `blob-fs`, `standalone`) need their own lib / types settings without loosening `core` and `http`. — *source: JOURNAL 2026-11-21 — M0 closed: final review, verification and research*
- [ ] M4: act on `.agents-docs/M4_ICEBERG_SPIKE_RESEARCH.md`: the Athena query engine cannot read v3 tables, winterbaume has no Docker image (compose must run the binary), Lakekeeper needs `sts-enabled: false` against winterbaume, and Cloudflare has no verified in-process write path. Revise the "ArchiveStore" engine list in ARCHITECTURE.md once the hands-on spikes report. — *source: JOURNAL 2026-11-21 — M0 closed: final review, verification and research*
- [x] M1d: make concurrent bootstrap of the same organization/project slug safe across processes and use cryptographically secure DSN keys. — *source: JOURNAL 2026-11-21 — M1c ingest pipeline; resolved in M1f*
- [x] M1d: configure the consumer envelope size limit consistently with the ingest service. — *source: JOURNAL 2026-11-21 — M1c ingest pipeline*
- [ ] M4 or retention slice: remove orphaned raw envelope and overflow blobs after crashes between pipeline steps. — *source: M1f review section B*
- [ ] M2: if snapshot-consistent issue pagination becomes a product requirement, add persistent snapshots or versioned history. M1 uses stateless keyset cursors, so concurrent sort-key changes can move rows across a cursor. — *source: JOURNAL 2026-11-21 — M1e adapter review fixes*
- [ ] M3: before adding Postgres/MySQL SQL dialects, add JSON and integer-affinity hooks and resolve the unused dialect kind; replace unbounded indexed text and handle MySQL lack of CREATE INDEX IF NOT EXISTS; specify binary collations for keyset parity; and account for MySQL changed-row counts in CAS. The current implementation is validated for SQLite only. — *source: M1e review section B*
- [ ] M4: investigate raw-deflate clients; Web DecompressionStream accepts zlib-framed deflate, and raw deflate currently returns 400. — *source: M1f review section B*
- [ ] M2: provide token management for non-local deployments; M1g adds local token reuse and rotation. — *source: JOURNAL 2026-11-21 — M1d local stack*
- [ ] M4: decide the physical-erasure (`hardErase`) path for v3 tables: DuckDB 2.0 cannot rewrite v3 data files. First test whether S3 Tables / Lakekeeper maintenance actually applies deletion vectors over a longer window; otherwise copy-forward, format v2, or a native rewrite. — *source: `.agents-docs/S3TABLES_DV_SPIKE.md`*
- [ ] M4: the DuckDB archive engine must set `iceberg_use_metadata_log = false` (or re-attach per operation) and retry commit conflicts; package the Lambda archive function as a container image with extensions baked in, `home_directory` under `/tmp`, env-based S3 secret. — *source: `.agents-docs/S3TABLES_DV_SPIKE.md`, `.agents-docs/DUCKDB_LAMBDA_SPIKE.md`*
- [ ] M4: untested by the spikes: Iceberg reads and writes from inside Lambda, Lakekeeper with winterbaume as its object store, Athena / Spark as readers, least-privilege IAM for S3 Tables. — *source: spike reports*
- [ ] M5 / UI: add per-project issue short IDs, actual distinct-user counts, and numeric-looking issue IDs if a client requires them; implement statsPeriod statistics and indexed environment and free-text filters. — *source: M1g closing review section B*
- [ ] CI: run the Python SDK end-to-end check required by ARCHITECTURE.md once a Python environment is available. — *source: M1g closing review section B*
- [ ] M2: provide indexed token enumeration and revocation for tokens issued before M1g; their plaintext was not retained, so local token rotation can revoke only the file-backed token. — *source: M1g closing review*

- [x] M2a2: complete the infra model redesign and review items A1-A13, validation items B1-B8, and documentation item C before M2b. — *source: `.agents-workspace/tmp/m2a-review-fixes.md`*


- [ ] M2b: render symbol-tagged references by phase, including keyed outputs and build artifacts; escape literal Terraform template introducers in values and object keys with `terraformLiteral` / `escapeTerraformLiteral`, and fail on missing backend generation environment values. — *source: M2a2 review A6 / A8 / A10 and B4*
- [ ] M2b: emit JSON variables as Terraform `string` holding JSON, validate that decoded values are objects or arrays, and wrap structured uses in `jsondecode`, matching CLI `TF_VAR_` parsing. — *source: M2a2 review B5*
- [ ] M2b: render reachable `existing` substitutions and stack outputs; attach per-resource policy outputs and materialize scoped secret-read requirements. Provider policy contents and absence of raw IAM in module inputs are not statically enforced. — *source: M2a2 review A2 / A4 / A11 and C*
- [x] M2b: choose queue visibility and consumer timeout defaults that satisfy the six-times rule whenever the queue supports visibility; core checks explicit values only. AWS defaults are 180 and 30 seconds. — *source: M2a2 review A6*
- [ ] M2c: satisfy each function's artifact reference with the actual build output, create role-scoped entrypoints and queue event-source mappings, and integrate runtime secret sources. — *source: M2a2 review A4 / A6 / A12*

- [x] M2b: implement AWS HCL module contracts declared by the Lambda, DynamoDB, SQS and S3 descriptors, including purpose-keyed policy outputs, SQS DLQs and event source mappings, S3 staging prefix permissions, HTTP URLs and scoped secret reads. — *source: M2b step 1*
- [ ] M3: implement the AWS runtime adapters; enforce the 1 MiB SQS body limit including serialization and envelope overhead, and make DynamoDB explicit deletion honor erasure semantics. — *source: M2b step 1*

- [ ] M2c / M3: match the Lambda module contract: ZIP artifacts exposing `index.handler`, EventBridge `{ "job": name }` dispatch, partial SQS batch failures, and lazy Secrets Manager ARN resolution. — *source: M2b step 2*
- [ ] M3: implement and test the DynamoDB sparse-index and lookup-item layout documented in `infra/modules/aws/README.md`, including eventual-consistency limits and explicit erasure. — *source: M2b step 2*

- [ ] M2b / M2c: address the remaining second-review items N5-N7 and document corrections before generator and build work. — *source: `.agents-workspace/tmp/m2a2-review-fixes.md`*
- [ ] M2 / M3 / M6: address second-review follow-ups N9 and N12-N15, including Cloudflare binding authorization and runtime limitations. — *source: `.agents-workspace/tmp/m2a2-review-fixes.md`*
