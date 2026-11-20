# M4 Iceberg spike research: engines, catalogs, and a possible native TypeScript committer

Research date: 2026-11-21. Method: web search, primary docs, release notes, GitHub repos/issues/PRs, npm registry metadata, and a read-only shallow clone of `moriyoshi/winterbaume` (commit `69fed1d`, 2026-10-27) and of the `icebird@0.9.9` npm tarball. Nothing was executed against real services: every statement about behavior is from documentation or source reading, not from a test run. Items marked UNVERIFIED could not be confirmed from a primary source.

## 0. Executive summary

- DuckDB 2.0.0 (released 2026-10-21) with the `iceberg` extension can ATTACH an Iceberg REST catalog and do INSERT, UPDATE, DELETE, MERGE INTO. It reads and writes format v2 and v3, and on v3 tables DELETE writes Puffin deletion vectors automatically. It is merge-on-read only (no copy-on-write).
- DuckDB cannot set custom snapshot summary properties (open feature request). Idempotency for the append has to come from somewhere else (a batch id column plus a pre-check, or a native committer).
- DuckDB has `iceberg_rewrite_data_files` (compaction). Snapshot expiry (`iceberg_expire_snapshots`) was merged to `main` on 2026-11-13 as metadata-only: it is not in the 2.0 docs, and file deletion is still an open PR.
- Lakekeeper is at v0.15.1 (2026-11-15). It supports S3-compatible storage with custom endpoint and path-style access, and it has its own maintenance task queues (expire snapshots, remove orphan files, opt-in optimize).
- winterbaume S3 is path-style only on custom endpoints, has conditional writes, multipart, range GET, ListObjectsV2 and STS AssumeRole, but does not appear to enforce credentials or session policies, and there is no published Docker image.
- AWS S3 Tables supports v3 including deletion vectors through its Iceberg REST endpoint, with automatic compaction (which applies row-level deletes), snapshot management and unreferenced file removal. Athena cannot read v3 tables.
- Cloudflare renamed R2 Data Catalog to Basin Catalog and R2 SQL to Basin SQL (both GA). The docs say nothing about Iceberg v3 or deletion vectors. Basin SQL is read-only. Pipelines `send()` confirms ingestion, not the Iceberg commit.
- A pure-JS library that writes Iceberg commits does exist: `icebird` (hyparam) claims experimental v2/v3 writes including deletion vectors and REST catalog commits. It is the only candidate for Workers, and it is experimental.
- Recommendation: DuckDB for append, query and DV deletes on local Node and Lambda. On Workers, do not write Iceberg in-process for now: query via Basin SQL HTTP API or a Lambda/container-hosted DuckDB, and treat `icebird` as a spike candidate. A small native TypeScript committer is justified only for (a) idempotent append with a summary property and (b) Workers. Details in section 7.

## A. DuckDB iceberg extension

### A.1 Versions

- Latest DuckDB is 2.0.0 LTS (2026-10-21). 1.5.6 was released 2026-09-28. 2.1.0 is planned for 2027 H1. Source: https://duckdb.org/release_calendar
- The Iceberg docs now live under `/docs/2.0/core_extensions/iceberg/`. Source: https://duckdb.org/docs/2.0/core_extensions/iceberg/overview.html

### A.2 ATTACH and write operations

- Attaching a REST catalog is required for writes. Supported with an attached catalog: CREATE/DROP SCHEMA, CREATE/DROP TABLE, INSERT INTO, UPDATE, DELETE, MERGE INTO, ALTER TABLE, SELECT. Writing to a table read via `iceberg_scan` is not supported. Source: https://duckdb.org/docs/2.0/core_extensions/iceberg/writing_to_iceberg.html
- UPDATE and DELETE work on partitioned and unpartitioned tables (same source). Note: Cloudflare's DuckDB page still says DuckDB does not support DELETE on partitioned tables. That statement refers to the 1.4-era limitation and is outdated relative to the 2.0 docs. Sources: https://developers.cloudflare.com/basin-catalog/config-examples/duckdb/ and the DuckDB page above.
- Partition transforms supported for writes: identity, year, month, day, hour, bucket, truncate. `write.target-file-size-bytes` and `write.parquet.row-group-size-bytes` are honored. Source: https://duckdb.org/docs/2.0/core_extensions/iceberg/writing_to_iceberg.html
- There is no documented "add existing Parquet files" function (`add_files`). An append is `INSERT INTO cat.ns.tbl SELECT ... FROM read_parquet(...)`, which rewrites the rows into new data files. Source: function list at https://duckdb.org/docs/2.0/core_extensions/iceberg/iceberg_functions.html (absence), plus a PR search on `duckdb/duckdb-iceberg` that found nothing.

### A.3 Format versions and deletion vectors

- v3 is supported for reads and writes: VARIANT, TIMESTAMP_NS, schema-level defaults, binary deletion vectors, row lineage. This arrived in 1.5.3. Sources: https://duckdb.org/2026/05/29/new-iceberg-features and https://duckdb.org/docs/2.0/core_extensions/iceberg/writing_to_iceberg.html
- Create a v3 table with `WITH ('format-version' = 3)`, or set the session default with `iceberg_default_format_version` (default 2, allowed 2 or 3). `ALTER TABLE ... SET` can change `format-version`. Sources: https://duckdb.org/docs/2.0/core_extensions/iceberg/iceberg_options.html and the writing page.
- v2 tables: positional deletes are written as Parquet delete files. v3 tables: the same deletes are written as deletion vectors in a Puffin file. The format is chosen automatically from the table's `format-version`. Source: writing page.
- Limitations (verbatim meaning): only positional deletes are written. Copy-on-write is not supported. If `write.update.mode` or `write.delete.mode` is anything other than `merge-on-read`, the operation fails. GEOGRAPHY is not supported. Source: writing page.
- A setting `iceberg_unsafe_skip_puffin_verification` exists (default false), which implies Puffin/DV verification on read. Source: options page.

### A.4 Snapshot summary properties and commit tagging

- Not supported. Issue #1249 "Support custom snapshot summary properties on Iceberg writes" is open (last updated 2026-07-29). It states that DuckDB currently generates only `operation` and the standard snapshot metrics, with no SQL-facing API for custom summary properties, and names idempotency keys as the motivating use case. Source: https://github.com/duckdb/duckdb-iceberg/issues/1249
- `iceberg_snapshots` returns `sequence_number`, `snapshot_id`, `timestamp_ms`, `manifest_list`: no summary column. Source: functions page.
- Table properties can be set (`set_iceberg_table_properties`, `ALTER TABLE ... SET`), but they are table-wide, not per snapshot. Source: functions page.
- UNVERIFIED: whether an INSERT and a table-property update inside one `BEGIN ... COMMIT` become one atomic REST commit. PR #1773 ("Apply the table updates of one statement one at a time", merged 2026-11-18) touches this area. Source: https://github.com/duckdb/duckdb-iceberg/pull/1773

### A.5 Maintenance functions

- `iceberg_rewrite_data_files(table)` is documented for 2.0. Parameters: `target_file_size_bytes`, `min_file_size_bytes`, `max_file_size_bytes`, `min_input_files` (default 5), `max_files_to_rewrite`, `rewrite_all` (default false), `output_spec_id`. It returns `removed_delete_files_count` among other counters. Source: functions page.
- PR #1622 (merged to `main` 2026-11-04) makes the rewrite drop a position-delete file in the same REPLACE commit when every live data file it applies to was rewritten. Source: https://github.com/duckdb/duckdb-iceberg/pull/1622
- UNVERIFIED: that this PR is in the extension binary served for DuckDB 2.0.0, and that the rewrite selects files because they carry deletes (Spark's `delete-file-threshold` equivalent). `rewrite_all => true` is the safe way to force a rewrite of affected files.
- `iceberg_expire_snapshots` was merged to `main` on 2026-11-13 (PR #1341) and is metadata-only: it removes snapshot entries and deletes no files. It rejects tables with any ref other than `main`. It is not listed in the 2.0 function docs. Source: https://github.com/duckdb/duckdb-iceberg/pull/1341
- Open follow-ups: delete files reachable only from expired snapshots (PR #1753), retry on conflict (PR #1764), keep branches and tags (PR #1745), orphan file cleanup (PR #1785), `iceberg_rewrite_manifests` (PR #1658). Sources: https://github.com/duckdb/duckdb-iceberg/pull/1753 , https://github.com/duckdb/duckdb-iceberg/pull/1785
- `iceberg_rollback_to_snapshot` exists. Source: functions page.
- Net: DuckDB alone cannot yet guarantee physical removal of deleted rows. The catalog (Lakekeeper, S3 Tables, Basin Catalog) has to do snapshot expiry and file cleanup.

### A.6 Query pruning

- `iceberg_column_stats`, `iceberg_partition_stats`, `iceberg_scan_plan` and `iceberg_files` exist to inspect what is pruned. Source: functions page.
- PR #1675 "Skip manifests without live files when planning scans" is still open. Source: https://github.com/duckdb/duckdb-iceberg/pull/1675
- UNVERIFIED: the exact extent of manifest-level partition pruning and data-file column-bound pruning in 2.0. The docs fetched do not spell it out. Use `iceberg_scan_plan` / `EXPLAIN ANALYZE` in the spike to confirm.
- Regression to be aware of: issue #1628 "COMMIT re-reads every existing manifest of the table, so commit cost grows with table history (2.0.0 regression)" is closed as of 2026-11-05. UNVERIFIED which binary carries the fix. Source: https://github.com/duckdb/duckdb-iceberg/issues/1628

### A.7 Catalog options, Lakekeeper, S3 Tables, Glue

- `AUTHORIZATION_TYPE`: `OAUTH2` (default), `SIGV4`, `NONE`. `ACCESS_DELEGATION_MODE`: `vended_credentials` (default) or `none`. `ENDPOINT_TYPE`: `S3_TABLES` or `GLUE`. Other compatibility switches: `STAGE_CREATE_TABLES`, `DISABLE_MULTI_TABLE_COMMIT`, `SKIP_CREATE_TABLE_METADATA_UPDATES`, `REMOVE_FILES_ON_DELETE`, `PURGE_REQUESTED`, `MAX_TABLE_STALENESS`. Source: https://duckdb.org/docs/2.0/core_extensions/iceberg/iceberg_options.html
- Remote signing is not supported. Issue #670 is open. PR #1318 ("Support Iceberg REST catalog remote request signing") is open, last updated 2026-11-11. Sources: https://github.com/duckdb/duckdb-iceberg/issues/670 , https://github.com/duckdb/duckdb-iceberg/pull/1318
- Lakekeeper is documented as a supported catalog (OAuth2 secret with `OAUTH2_SCOPE` and `OAUTH2_SERVER_URI`) and is used in the extension's CI (PR #1763 "Bump Lakekeeper to v0.14.1", merged 2026-11-17). Sources: https://duckdb.org/docs/2.0/core_extensions/iceberg/catalogs.html , https://github.com/duckdb/duckdb-iceberg/pull/1763
- Known Lakekeeper + custom S3 endpoint problem: issue #590 (open). Data Parquet files are written but the manifest Avro read fails with 403 when credentials for a custom endpoint are configured through a secret. Reported workarounds: `ACCESS_DELEGATION_MODE none` on ATTACH, and/or an S3 secret using `PROVIDER credential_chain`. Source: https://github.com/duckdb/duckdb-iceberg/issues/590
- Other open issues: OAuth2 `http_timeout` not propagated so a multi-table commit can hang (#955), nested namespace handling (#1641), refreshable bearer auth (#1374). Sources: https://github.com/duckdb/duckdb-iceberg/issues/955 , https://github.com/duckdb/duckdb-iceberg/issues/1641
- S3 Tables: `ATTACH '<table bucket ARN>' AS c (TYPE iceberg, ENDPOINT_TYPE s3_tables)` with an S3 secret from `PROVIDER credential_chain`. `ENDPOINT_TYPE S3_TABLES` implies SigV4, `STAGE_CREATE_TABLES false`, `REMOVE_FILES_ON_DELETE false`, `PURGE_REQUESTED true`. Sources: catalogs page and options page.
- Glue: `ATTACH '<account id>' AS c (TYPE iceberg, ENDPOINT_TYPE 'glue')`, requires a secret. Source: catalogs page.
- UNVERIFIED: DuckDB writing v3 deletion vectors specifically against S3 Tables or Glue. Each side documents v3 separately. The combination is not documented.

### A.8 DuckDB in AWS Lambda with `@duckdb/node-api`

- `@duckdb/node-api` is at `2.0.0-r.1` (published 2026-10-21). Platform binaries are separate packages for glibc Linux: `@duckdb/node-bindings-linux-x64` and `-linux-arm64`, each about 96 to 100 MB unpacked. Source: npm registry (`npm view`), https://www.npmjs.com/package/@duckdb/node-api
- Extension loading in a read-only filesystem: DuckDB docs describe downloading extension binaries from `http://extensions.duckdb.org/v<version>/<platform>/<name>.duckdb_extension.gz`, then `INSTALL '<path>'` or `LOAD '<path>'`, and explicitly say this helps when building a Lambda service or container. Source: https://duckdb.org/docs/2.0/extensions/advanced_installation_methods.html
- Published Lambda examples (Python, not Node) set `home_directory` to `/tmp` and `extension_directory` to a path under `/tmp`, or bake httpfs, aws, avro and iceberg into a container image at build time. Sources: https://dev.classmethod.jp/en/articles/duckdb-1-4-iceberg-write-aws-lambda/ , https://aws.amazon.com/blogs/database/run-duckdb-analytics-on-your-amazon-dynamodb-data-with-zero-etl/ , https://builder.aws.com/content/3JB43F4tw0kjNCVXk3xVBmfMhEs/duckdb-in-a-lambda-the-lightweight-etl-to-s3tables
- UNVERIFIED: a Node-specific Lambda write-up for `@duckdb/node-api`. The mechanism is the same C library, so the same settings should apply. Also UNVERIFIED: cold start time for loading iceberg + httpfs + avro + aws (no source gave numbers).
- Practical shape: container image on Node 22, `npm ci` with the linux binding, a build step that runs `INSTALL iceberg; INSTALL httpfs; INSTALL avro; INSTALL aws;` into a directory inside the image, and at runtime `SET home_directory='/tmp'`, `SET extension_directory='<baked dir>'`, `LOAD ...`, in-memory database, `SET temp_directory='/tmp/...'`.

## B. Lakekeeper

- Current version: v0.15.1 (2026-11-15). v0.15.0 was 2026-11-06. A 0.16.0 release PR is open. Source: https://github.com/lakekeeper/lakekeeper/releases
- Image: `quay.io/lakekeeper/catalog`. Tag `v0.15.1` exists (2026-11-15). The repo compose files default to `latest-main`. Sources: https://quay.io/repository/lakekeeper/catalog?tab=tags , https://github.com/lakekeeper/lakekeeper/blob/main/docker-compose/docker-compose.yaml
- Requires Postgres 15 or newer (compose uses `postgres:17`). Source: https://docs.lakekeeper.io/getting-started/
- Compose shape (from the repo): a `migrate` one-shot (`command: ["migrate"]`), then `serve` on port 8181, env `LAKEKEEPER__PG_ENCRYPTION_KEY`, `LAKEKEEPER__PG_DATABASE_URL_READ`, `LAKEKEEPER__PG_DATABASE_URL_WRITE`, and `LAKEKEEPER__AUTHZ_BACKEND=allowall` for no-auth use. Healthcheck: `/home/nonroot/lakekeeper healthcheck`. Source: https://github.com/lakekeeper/lakekeeper/blob/main/docker-compose/docker-compose.yaml
- Bootstrap: `POST /management/v1/bootstrap` with body `{"accept-terms-of-use": true}`. Warehouse: `POST /management/v1/warehouse` with a JSON body. Source: https://github.com/lakekeeper/lakekeeper/blob/main/examples/minimal/docker-compose.yaml
- Storage profiles: `s3` (AWS, S3-compatible, Cloudflare R2, Alibaba OSS), `stackit`, `adls`, `onelake`, `gcs`. Source: https://docs.lakekeeper.io/docs/0.15.x/storage/
- S3 profile fields relevant to winterbaume: `endpoint` (URL), `path-style-access` (default false), `flavor` (`aws` or `s3-compat`), `sts-enabled` (required), `sts-endpoint` (defaults to `endpoint`), `remote-signing-enabled` (default true), `remote-signing-url-style` (`auto`, `path`, `virtual_host`), `region` (any string for S3-compatible), `key-prefix`. So a custom endpoint with path-style access is supported. Source: https://docs.lakekeeper.io/docs/0.15.x/storage-s3/
- Vended credentials are documented as tested against AWS, Silo and SeaweedFS. Remote signing needs only SigV4. The repo's minimal example now uses Silo (a MinIO fork, `pgsty/silo`) instead of MinIO. Sources: storage-s3 page and https://github.com/lakekeeper/lakekeeper/blob/main/examples/minimal/docker-compose.yaml
- Warehouse creation runs storage validation, and a failed check blocks creation: `lakekeeper-read-write` (write, read back, delete a probe file), `vended-credentials-issued`, `vended-credentials-read-write`, `vended-credentials-scope-enforced` (downscoped credentials must be refused outside the table location), `cleanup`. `LAKEKEEPER__SKIP_STORAGE_VALIDATION=true` skips all of them. Source: https://docs.lakekeeper.io/docs/0.15.x/storage-validation/
- When no credentials are vended, region, endpoint and path-style settings are still returned in the table `config` for clients that bring their own credentials. Source: https://docs.lakekeeper.io/docs/0.15.x/storage/
- Iceberg v3: supported, by evidence rather than by a single doc sentence. The v3 feature request #1273 was closed 2025-09-24, issue #1690 ("Error upgrading v2 table to v3 table with existing snapshots") was closed 2026-04-01, and warehouses have a "format-version policy" (allowed and default format versions, PRs #1954 and #2279). Sources: https://github.com/lakekeeper/lakekeeper/issues/1273 , https://github.com/lakekeeper/lakekeeper/issues/1690 , https://github.com/lakekeeper/lakekeeper/pull/2279
- UNVERIFIED: the default format-version policy of a new warehouse (whether v3 is allowed out of the box) and the first release with v3 support.
- Maintenance done by Lakekeeper itself. Source for all four: https://docs.lakekeeper.io/docs/0.15.x/table-maintenance/
  - Metadata file cleanup: automatic, honors `write.metadata.delete-after-commit.enabled` and `write.metadata.previous-versions-max`.
  - Expire snapshots: a task queue configured per warehouse at `/management/v1/warehouse/{id}/task-queue/expire_snapshots/config`. `enable-expire-snapshots` defaults to false, `max-snapshot-age-ms` 5 days, `min-snapshots-to-keep` 1. Ages below 24 hours are rejected unless `disable-min-age-check` is true.
  - Remove orphan files: opt-in per warehouse, `default-older-than-ms` 7 days, 24 hour minimum unless `disable-min-older-than-check` is true. Does a full recursive listing of the table location.
  - Optimize: opt-in, compacts small data files, applies delete files, merges small manifests.
- UNVERIFIED: whether these task queues are in the open-source edition or only in Lakekeeper Plus (the page mentions "Lakekeeper Plus 0.15" once, and an older issue #1620 reported the `expire_snapshots` queue as not registered in the open-source build), and whether Optimize handles v3 deletion vectors. Source: https://github.com/lakekeeper/lakekeeper/issues/1620
- Commit behavior relevant to errtraq: 0.15 returns a retryable conflict (409) for a snapshot built on outdated metadata (PR #2218). Source: https://github.com/lakekeeper/lakekeeper/releases/tag/v0.15.0

## C. winterbaume

- What it is: "A stateful AWS service emulator for integration testing", written in Rust, usable in-process in Rust tests or as a standalone server. Inspired by moto. Apache-2.0. Sources: https://winterbaume.pages.dev , https://github.com/moriyoshi/winterbaume
- Source: https://github.com/moriyoshi/winterbaume (crates under `crates/winterbaume-*`, server in `crates/winterbaume-server`).
- Running the server. Source: https://winterbaume.pages.dev/guide/server-mode.html and https://winterbaume.pages.dev/guide/getting-started.html
  - `cargo install winterbaume-server` then `winterbaume-server --host 127.0.0.1 --port 5555`.
  - From a checkout: `cargo run -p winterbaume-server -- --host 127.0.0.1 --port 5555`.
  - Prebuilt binaries on GitHub releases for macOS (arm64, x64), Linux (arm64, x64), Windows (x64). Latest GitHub release tag: `winterbaume-server-v0.2.6` (2026-08-18). `main` has `winterbaume-server` at 0.2.8. Source: https://github.com/moriyoshi/winterbaume/releases
  - No Docker image: there is no Dockerfile in the repo and no image is mentioned in the README or guides (checked in the clone).
- Defaults: host `127.0.0.1`, port `5555`, account `123456789012`, region `us-east-1`. Flags: `--host`, `--port`, `--account-id`, `--region`, `--tfstate`, `--config`, `--sqs-backend`, `--dynamodb-backend`, `--vfs-dir`. Env: `WB_HOST`, `WB_PORT`, `WB_ACCOUNT_ID`, `WB_REGION`, `WB_VFS_DIR`, and so on. Source: server-mode guide.
- Persistence: in memory by default. `--vfs-dir` stores S3 blobs on disk but needs the `backend-vfs-fs` cargo feature. If the feature is missing the server warns and falls back to memory. Source: server-mode guide. UNVERIFIED: whether the prebuilt release binaries include that feature.
- Clients: `AWS_ENDPOINT_URL=http://localhost:5555`, dummy keys `test` / `test`. Source: getting-started guide.
- Request routing: first by host regex (real `amazonaws.com` host names), then by the SigV4 credential scope in the `Authorization` header. Otherwise `404 UnknownService`. Source: server-mode guide, and `crates/winterbaume-server/src/main.rs`.
- Coverage (operations with state-backed logic / total). Source: https://winterbaume.pages.dev/reference/services.html
  - S3 103/107 (stubs: `CreateSession`, `GetBucketPolicyStatus`, `GetObjectTorrent`, `RestoreObject`), S3 Tables 46/49, S3 Control 87/97, DynamoDB 57/57, SQS 23/23, STS 11/11, IAM 154/176, Glue 132/265, Athena 25/70, Lambda 85/85, KMS 53/54.
- S3 addressing: "winterbaume only supports path-style S3 URLs (`http://host:port/bucket/key`). Virtual-hosted-style URLs are not supported when using a custom endpoint." Source: https://github.com/moriyoshi/winterbaume/blob/main/crates/winterbaume-s3/README.md
- S3 features confirmed by reading `crates/winterbaume-s3/src/handlers.rs` at commit `69fed1d` (source: https://github.com/moriyoshi/winterbaume/blob/main/crates/winterbaume-s3/src/handlers.rs):
  - Conditional writes: `If-Match` / `If-None-Match` on PutObject, CopyObject and CompleteMultipartUpload, returning 412 PreconditionFailed. Conditional reads and conditional deletes are also handled.
  - Multipart: CreateMultipartUpload, UploadPart, UploadPartCopy, CompleteMultipartUpload, AbortMultipartUpload.
  - Range GET: the `Range` header is parsed, with `InvalidRange` (416) for bad ranges.
  - ListObjectsV2 with `continuation-token`. DeleteObjects (batch delete).
- Limits and risks for the Lakekeeper + DuckDB role (all from source reading, so treat as UNVERIFIED until run):
  - Presigned URLs: there is no query-string (`X-Amz-Credential` / `X-Amz-Signature`) handling in `winterbaume-core/src/auth.rs` or the server. A presigned request to `localhost:5555` carries no `Authorization` header and matches no host pattern, so it would most likely get `404 UnknownService`. Lakekeeper and DuckDB do not need presigned URLs, but the errtraq upload path might.
  - No signature or credential verification was found (no `SignatureDoesNotMatch` / `InvalidAccessKeyId` paths in core or S3). Any key works.
  - STS `AssumeRole` returns random `ASIA...` credentials and does not evaluate the session policy. S3 does not check the credentials either. Consequence: Lakekeeper's `vended-credentials-scope-enforced` validation check (which expects writes outside the table location to be refused) would likely fail with `sts-enabled: true`. Use `sts-enabled: false` or skip validation.
  - No `aws-chunked` / `STREAMING-*` payload decoding was found by grep in the S3 or core crates. AWS SDK for JavaScript v3 can use chunked trailers for streaming uploads with flexible checksums. UNVERIFIED either way: test errtraq's own SDK uploads against it.
  - S3 Tables: the control-plane API is implemented (46/49), but no Iceberg REST catalog routes (`/iceberg/v1/...`) were found in `winterbaume-s3tables`. Glue: no Iceberg REST handling found. So winterbaume cannot stand in for the S3 Tables or Glue Iceberg REST endpoints: Lakekeeper must be the catalog locally.

## D. AWS

- V3 support. Source: https://docs.aws.amazon.com/AmazonS3/latest/userguide/working-with-apache-iceberg-v3.html
  - AWS supports deletion vectors, row lineage, column defaults and all v3 data types. S3 Tables supports all v3 data types.
  - Support table: EMR Spark 7.12+, Glue ETL 5.1+, "AWS Glue: Iceberg REST API, Table Maintenance: Yes", "Amazon S3 Tables: Iceberg REST API, Table Maintenance: Yes", "Amazon Athena (Trino): No", Redshift patch 204+.
  - "Amazon Athena can't read V3 tables."
  - V3 is a one-way upgrade. After upgrading, "The next compaction will remove old V2 delete files" and "New modifications will use V3's Deletion Vector files".
  - Deletion vectors and row lineage are available in all regions where S3 Tables operates.
- Inconsistency: the Glue REST endpoint page still says the endpoint "supports both Apache Iceberg table specifications - v1 and v2, defaulting to v2". Treat Glue REST + v3 as needing a test. Source: https://docs.aws.amazon.com/glue/latest/dg/connect-glu-iceberg-rest.html
- S3 Tables Iceberg REST endpoint. Source: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-integrating-open-source.html
  - `https://s3tables.<REGION>.amazonaws.com/iceberg`, warehouse is the table bucket ARN, SigV4 signing name `s3tables`. OAuth is not supported.
  - Supported: getConfig, list/create/load/drop namespace, list/create/load/update/drop/rename table, tableExists, namespaceExists.
  - Not supported: `stage-create` (so no CTAS), dropping with `purge=false`, multi-level namespaces, views, `metadata.json` over 50 MB. Maintenance is not exposed through REST: use the S3 Tables maintenance APIs.
  - AWS recommends the Glue REST endpoint for anything beyond "basic read/write access to a single table bucket".
- Can DuckDB use S3 Tables purely through REST: yes per DuckDB docs (`ENDPOINT_TYPE s3_tables`, credentials via the `aws` extension credential chain). Source: https://duckdb.org/docs/2.0/core_extensions/iceberg/catalogs.html . A Lambda example exists: https://builder.aws.com/content/3JB43F4tw0kjNCVXk3xVBmfMhEs/duckdb-in-a-lambda-the-lightweight-etl-to-s3tables
- Glue REST endpoint: `https://glue.<region>.amazonaws.com/iceberg`, signing name `glue`, single-level namespaces, SigV4 or OAuth bearer. Source: Glue page above.
- Automatic maintenance on S3 Tables (enabled by default). Sources: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-maintenance.html , https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-table-buckets-maintenance.html , https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-considerations.html
  - Compaction: default target 512 MB (64 to 512 MB), strategies auto / binpack / sort / z-order. "When combining objects, compaction also applies the effects of row-level deletes in your table." Binpack "combines small files into larger files ... while applying any pending deletes".
  - Snapshot management: `minimumSnapshots` 1, `maximumSnapshotAge` 120 hours (minimum 1 hour). Objects referenced only by expired snapshots become noncurrent and are deleted after `nonCurrentDays`.
  - Unreferenced file removal (bucket level): `unreferencedDays` 3, `nonCurrentDays` 10 (minimum 1 each).
  - Snapshot management fails for the whole table if any user-defined tag or branch exists, or if `history.expire.max-snapshot-age-ms` / `history.expire.min-snapshots-to-keep` are set as table properties.
  - Compaction and user commits can conflict under optimistic concurrency. AWS recommends retry logic in writers.
- Does compaction physically remove DV-deleted rows: the docs say compaction applies row-level deletes, and the v3 page says maintenance supports v3. An AWS announcement states deletion vector support for S3 Tables maintenance (seen only as a search snippet, not fetched): https://aws.amazon.com/about-aws/whats-new/2025/11/aws-apache-iceberg-v3-deletion-vectors-row-lineage
- UNVERIFIED: how soon compaction picks up a data file whose only change is a new deletion vector (no documented threshold or trigger), and whether there is an API to force a compaction run. With defaults, physical removal after compaction still takes up to 120 hours (snapshot age) plus 10 days (noncurrent). For a GDPR-style deadline, set `maxSnapshotAgeHours` and `nonCurrentDays` explicitly and measure.

## E. Cloudflare

- Naming: R2 Data Catalog is now "Basin Catalog" and R2 SQL is now "Basin SQL". Both are Generally Available. Existing R2 Data Catalog / R2 SQL APIs keep working and will be deprecated later. Sources: https://developers.cloudflare.com/basin-catalog/ , https://developers.cloudflare.com/basin-sql/
- Basin Catalog exposes a standard Iceberg REST catalog. Documented engines: Spark, Snowflake, PyIceberg, DuckDB, StarRocks, Trino. Auth is a bearer API token. Source: https://developers.cloudflare.com/basin-catalog/llms.txt and https://duckdb.org/docs/2.0/core_extensions/iceberg/catalogs.html
- Iceberg version and deletion vectors: UNVERIFIED. The full docs dump (https://developers.cloudflare.com/basin-catalog/llms-full.txt) contains no mention of `format-version`, v3, Puffin, deletion vectors, or positional vs equality deletes. The deleting-data page only describes copy-on-write vs merge-on-read through Spark. Source: https://developers.cloudflare.com/basin-catalog/deleting-data/
- Table maintenance. Source: https://developers.cloudflare.com/basin-catalog/table-maintenance/
  - Compaction: opt-in per catalog or per table (`wrangler basin catalog compaction enable ... --target-size 128`), target 64 to 512 MB, Parquet only. The maintenance tab also reports manifest rewrite.
  - Snapshot expiration: opt-in, `--older-than-days` (default 30), `--retain-last` (default 5). Since 2026-04-22 it also removes unreferenced data files. Source: https://developers.cloudflare.com/changelog/post/2026-04-22-snapshot-expiration-cleans-data-files/
  - Orphan files (never referenced by a snapshot) are not cleaned up.
  - UNVERIFIED: whether automatic compaction applies delete files or deletion vectors. The deleting-data page says that for merge-on-read tables "you may need to manually apply deletes" with `rewrite_data_files`.
  - Limitation: buckets in a non-default jurisdiction are not supported.
- Basin SQL. Sources: https://developers.cloudflare.com/basin-sql/reference/limitations-best-practices/ , https://developers.cloudflare.com/basin-sql/query-data/ , https://developers.cloudflare.com/basin-sql/troubleshooting/
  - Read-only: only SELECT (and EXPLAIN). INSERT, UPDATE, DELETE, CREATE, DROP, ALTER are rejected.
  - Supported: WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET, DISTINCT, QUALIFY, joins (inner, left, right, full, cross), CTEs, subqueries, set operations, window functions, struct/array/map access.
  - Not supported: named WINDOW clause, LATERAL, UNNEST, PIVOT, nested joins, `NOT IN` subquery on nullable columns, `PERCENTILE_DISC`.
  - Limits: `LIMIT` must be between 1 and 10,000. Heavy queries can time out. Some functions are budget-gated and rejected with 400 before running. Parquet only.
  - Access: `wrangler basin sql query`, or `POST https://api.sql.cloudflarestorage.com/api/v1/accounts/{ACCOUNT_ID}/basin-sql/query/{BUCKET_NAME}` with a bearer token and body `{"query": "..."}`. No Workers binding is documented, so a Worker would call the HTTP API with `fetch`.
  - UNVERIFIED: whether Basin SQL applies delete files / deletion vectors when reading (not mentioned), the query timeout value, and the response format.
- Pipelines as the write path. Sources: https://developers.cloudflare.com/pipelines/ , https://developers.cloudflare.com/pipelines/streams/writing-to-streams/ , https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/ , https://developers.cloudflare.com/pipelines/platform/limits/
  - Worker binding: `await env.STREAM.send(events)`. It "returns a Promise that resolves when records are confirmed as ingested" into the stream. That is durable ingestion, not the Iceberg commit.
  - "Sinks provide exactly-once delivery guarantees." Events that fail schema validation are accepted and then dropped.
  - Data Catalog sink: Parquet only, creates the namespace and table if missing, roll interval minimum 60 seconds for Data Catalog sinks, roll size configurable. Sinks and pipeline SQL cannot be modified after creation.
  - Limits: 5 MB per ingestion request, 5 MB/s per stream, 20 streams / sinks / pipelines per account.
  - A Worker cannot learn when a given batch has been committed to the table, other than by polling the table (Basin SQL or the REST catalog). There is no delete or update path through Pipelines.
- Can a Worker itself append or delete: only with a pure-JS library (see F). DuckDB's native binary cannot run in Workers. `@duckdb/duckdb-wasm` is about 149 MB unpacked on npm (https://www.npmjs.com/package/@duckdb/duckdb-wasm). UNVERIFIED: whether duckdb-wasm with the iceberg extension can fit or run inside Workers limits. Assume no.

## F. JavaScript / TypeScript Iceberg ecosystem

- `iceberg-js` (Supabase) 1.0.0, 2026-06-08: REST catalog client only. It exposes `updateTable` / `commitTable` with the spec `{requirements, updates}` shape, `loadTable` with vended-credential results, fetch-based with pluggable auth headers. It explicitly does not read or write data or metadata files. Useful as the REST transport of a native committer. Sources: https://github.com/supabase/iceberg-js , https://supabase.com/blog/introducing-iceberg-js
- `icebird` (hyparam) 0.9.9, 2026-11-11, MIT: the one JS library found that writes Iceberg. Source: https://github.com/hyparam/icebird (README), plus the npm tarball.
  - README: "reads and writes Iceberg v1/v2/v3 tables, runs SQL queries over them, and speaks to file-based or REST catalogs". "Experimental write support for Iceberg v2 (and v3 deletion vectors)."
  - Write API: `icebergCreateTable`, `icebergAppend({catalog, namespace, table, records})`, `icebergDelete({deletes: [{file_path, pos}]})` ("v3 writes deletion vectors; v2 writes parquet delete files"), `icebergUpsert` (v2), `icebergRewrite` (compaction with deletes applied, v2 tables), `icebergRewriteManifests`, `icebergExpireSnapshots`, `icebergSetRef`, `icebergUpdateSchema`, `icebergTransaction`.
  - Puffin: "Supports uncompressed `deletion-vector-v1` blobs only."
  - Scan pruning: manifests via partition summaries, data files via partition tuples and column bounds, row groups via Parquet statistics. Own SigV4 via Web Crypto, path-style option for R2 / MinIO style endpoints. Dependencies: hyparquet, hyparquet-writer, hyparquet-compressors, squirreling (SQL).
  - S3 Tables subpath is read-only. Glue REST is not supported.
  - Gaps for errtraq (from the exported function signatures in 0.9.9): `icebergAppend` takes `records`, not an existing Parquet file, and has no parameter for custom snapshot summary properties. `icebergDelete` takes explicit `(file_path, pos)` pairs, so errtraq must scan to find positions. `icebergRewrite` is documented for v2 tables.
  - UNVERIFIED: runs on Cloudflare Workers (it uses fetch and Web Crypto, which suggests yes), interoperability of its v3 DVs with DuckDB / Spark / S3 Tables, behavior with Lakekeeper vended credentials, and production maturity (version 0.x, "experimental").
- Parquet writers:
  - `hyparquet-writer` 0.18.0 (2026-10-29): pure JS, one dependency, Snappy by default, column statistics on by default, optional column index and bloom filters, `kvMetadata`, VARIANT support. Source: https://github.com/hyparam/hyparquet-writer . UNVERIFIED: setting Parquet `field_id` on schema elements (Iceberg wants field ids, or a name mapping). icebird builds on it, so the capability presumably exists.
  - `parquet-wasm` 0.9.0 (2026-09-25): Rust Parquet compiled to WASM, about 16 MB unpacked. Source: https://github.com/kylebarron/parquet-wasm . UNVERIFIED: fits a Worker bundle.
- Avro writers: `avsc` 5.7.9 (last published 2025-07) and `avro-js` 1.12.2 (Apache, 2026-08). Sources: https://www.npmjs.com/package/avsc , https://www.npmjs.com/package/avro-js . UNVERIFIED: Workers compatibility of either (both have Node heritage). icebird ships its own Avro reader/writer under `src/avro`, which is evidence that a small purpose-built Avro object-container writer is feasible and probably the cleaner path.
- Roaring bitmaps: `roaring` 2.7.0 is a native Node addon (not usable on Workers). `roaring-wasm` 1.1.0 (2024-10) is a WASM port for Node, browser and Deno, with serialize / deserialize taking a format argument. Sources: https://www.npmjs.com/package/roaring , https://github.com/SalvatorePreviti/roaring-wasm . UNVERIFIED: 64-bit bitmap support in `roaring-wasm`. The Iceberg DV blob needs the 64-bit "portable" layout (a count of 32-bit keys, each followed by a 32-bit portable roaring bitmap), wrapped as length (4 bytes big-endian) + magic `D1 D3 39 64` + bitmap + CRC-32 (big-endian). Source: https://iceberg.apache.org/puffin-spec/ . For errtraq's volumes (a few positions per file) this is small enough to hand-write: array containers only, no run or bitset containers needed for writing.
- Puffin: no standalone JS Puffin library found. icebird has `src/puffin`. The file format is simple (magic, blobs, JSON footer). Source: https://iceberg.apache.org/puffin-spec/

### F.1 Effort estimate for a minimal native committer

Assumptions: one table, fixed schema, identity/day partitioning, format v3, REST catalog only, no schema evolution, no manifest merging beyond "carry forward existing manifests".

- Append one already-written Parquet data file:
  - Read the Parquet footer for record count, column sizes, null counts, lower/upper bounds (hyparquet): about 150 to 250 lines.
  - Iceberg single-value binary encoding for bounds and partition tuples: about 100 lines.
  - Avro object-container writer for the v3 `manifest_entry` / `data_file` schema and the `manifest_file` (manifest list) schema, including the required Avro file metadata (`schema`, `partition-spec`, `format-version`, `content`): about 400 to 600 lines including schemas.
  - Manifest list: read the parent snapshot's manifest list (needs an Avro reader, about 200 lines, or reuse icebird), append the new manifest, write a new list.
  - v3 specifics: `first-row-id` on the snapshot and manifest list entries, `next-row-id` bookkeeping, sequence number inheritance.
  - REST commit: `add-snapshot` + `set-snapshot-ref` updates with `assert-ref-snapshot-id` requirement, 409 retry loop, summary with `operation: append` and counters plus a custom `errtraq.batch-id`: about 150 lines on top of `iceberg-js` or raw fetch.
  - Object IO: SigV4 PUT/GET (for example `aws4fetch`) or vended credentials handling.
  - Estimate: 1,200 to 1,800 lines of TypeScript plus tests, about 1.5 to 2.5 weeks including cross-engine verification (DuckDB and Spark or PyIceberg reading the result).
- Add a deletion vector:
  - Find positions: scan the affected data files for matching rows with row ordinals (hyparquet).
  - DV serialization (64-bit portable roaring, length + magic + CRC) and Puffin file with a `deletion-vector-v1` blob (`referenced-data-file`, `cardinality` properties): about 250 to 350 lines.
  - Delete manifest (content = deletes) with entries carrying `content_offset`, `content_size_in_bytes`, `referenced_data_file`: reuses the Avro writer, about 150 lines.
  - Spec rule: at most one DV per data file per snapshot, so an existing DV for the same data file must be read, merged, and its old entry removed in the same commit. That adds a DV reader and manifest rewrite logic: about 300 lines.
  - Commit with `operation: delete`, and conflict validation (the data file must still be live): about 100 lines.
  - Estimate: another 1 to 2 weeks. The merge-existing-DV rule and concurrent compaction conflicts are the risky parts.
- Not included: rewrite of data files, snapshot expiry, orphan cleanup (leave these to the catalog or to DuckDB).
- Alternative: adopt or fork `icebird` and add (a) "append existing data file" and (b) custom summary properties. Likely days, not weeks, but it ties errtraq to an experimental library.

## 7. Recommendation

### 7.1 Engine per environment

| Operation | (i) Local Node + Lakekeeper + winterbaume | (ii) AWS Lambda (Node 22 container) | (iii) Cloudflare Workers |
| --- | --- | --- | --- |
| Append staged Parquet as one snapshot | DuckDB (`@duckdb/node-api`): `INSERT INTO ... SELECT ... FROM read_parquet(staged)` in one transaction | Same, against S3 Tables (`ENDPOINT_TYPE s3_tables`) | Not in-process. Option 1: Pipelines (`send()`, no per-batch commit signal). Option 2: call a Lambda / container that runs DuckDB against Basin Catalog. Option 3 (spike): icebird |
| Query with pruning | DuckDB | DuckDB | Basin SQL HTTP API (read-only, LIMIT max 10,000), or the same Lambda / container |
| DV delete (PII erasure) | DuckDB `DELETE` on a v3 table | DuckDB `DELETE` on a v3 S3 Tables table | Not available natively. Delegate to DuckDB elsewhere, or icebird after a spike. v3 on Basin Catalog is unverified |
| Rewrite affected data files | DuckDB `iceberg_rewrite_data_files(..., rewrite_all => true)` | S3 Tables automatic compaction (optionally also DuckDB rewrite to control timing) | Basin Catalog compaction (delete handling unverified), or DuckDB elsewhere |
| Snapshot expiry + file removal | Lakekeeper task queues (if available in the edition used), else not covered | S3 Tables snapshot management + unreferenced file removal | Basin Catalog snapshot expiration |

### 7.2 Is a native TypeScript committer needed

- Not for Lambda or local Node: DuckDB covers append, query and DV delete.
- It is the only way to get two things DuckDB lacks today:
  - a snapshot summary property carrying the batch id (clean idempotency), and
  - committing the staged Parquet file as-is (no re-encode).
- Without it, idempotent append on DuckDB should be designed as: a `archive_batch_id` column in the data, a pre-check (`SELECT 1 ... WHERE archive_batch_id = ? LIMIT 1`) before the INSERT, a single writer per table (or a lock in the active store), and a ledger row in the active store updated after the commit. An unknown commit outcome is resolved by re-running the pre-check. This is good enough to start.
- For Workers a native path is required if Workers must write. Prefer evaluating icebird first over writing from scratch. Decide after the spike.
- Suggested order: (1) DuckDB everywhere it runs, with the batch-id-column idempotency. (2) Spike icebird against Lakekeeper + winterbaume and read its output with DuckDB. (3) Only if (2) fails and Workers writes are a hard requirement, build the minimal committer in F.1.

### 7.3 Top risks

1. DuckDB iceberg is moving fast: 2.0.0 regressions (issues #1627, #1628), and maintenance features (`iceberg_expire_snapshots`, delete cleanup in rewrite) are only on `main`. Pin the DuckDB and extension version, and test rewrite-after-delete explicitly.
2. Physical erasure is not under errtraq's control: it depends on catalog-side expiry and cleanup (Lakekeeper queue availability and 24 hour minimums, S3 Tables 120 hour + 10 day defaults, Basin Catalog 30 day default and unknown delete handling). Measure the end-to-end time from DELETE to bytes gone on each platform.
3. winterbaume fidelity: no credential or session-policy enforcement, presigned URLs probably unsupported in server mode, chunked uploads unverified. Vended credentials cannot be tested realistically. Use static credentials locally (`sts-enabled: false`, DuckDB `ACCESS_DELEGATION_MODE none`), which is the path with a known open DuckDB issue (#590).
4. Cloudflare: no documented v3 / deletion vector support, no in-Worker engine, Pipelines gives no commit acknowledgment, Basin SQL is read-only with a 10,000 row limit. The Workers target cannot meet requirement (3) today without an external engine or an experimental library.
5. Athena cannot read v3 tables, and the Glue REST page still says v1/v2. Choosing v3 removes Athena as a query fallback.
6. Idempotency without summary properties relies on a single-writer discipline. A crash between commit and ledger update must be handled by the pre-check.
7. Lambda packaging: about 100 MB binding plus extensions, cold start unmeasured, extension autoload must be disabled or pointed at a baked directory.

### 7.4 Local docker-compose sketch

Everything about winterbaume in a container is UNVERIFIED (no official image). The Lakekeeper parts follow the repo's compose files.

```yaml
# compose.yaml (sketch, not run)
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: postgres
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 2s
      timeout: 10s
      retries: 10

  winterbaume:
    # UNVERIFIED: no published image. Build from the GitHub release tarball.
    build:
      context: ./docker/winterbaume
      # Dockerfile sketch:
      #   FROM debian:bookworm-slim
      #   ADD https://github.com/moriyoshi/winterbaume/releases/download/winterbaume-server-v0.2.6/winterbaume-server-x86_64-unknown-linux-gnu.tar.xz /tmp/wb.tar.xz
      #   RUN apt-get update && apt-get install -y xz-utils ca-certificates \
      #       && tar -xJf /tmp/wb.tar.xz -C /usr/local/bin --strip-components=1
      #   ENTRYPOINT ["winterbaume-server"]
      # UNVERIFIED: archive layout, glibc requirement, arm64 asset name for Apple Silicon hosts
      #   (winterbaume-server-aarch64-unknown-linux-gnu.tar.xz).
    command: ["--host", "0.0.0.0", "--port", "5555", "--region", "us-east-1"]
    environment:
      RUST_LOG: info
      # WB_VFS_DIR: /data   # UNVERIFIED: needs the backend-vfs-fs feature in the binary
    ports:
      - "5555:5555"

  create-bucket:
    image: amazon/aws-cli:latest
    depends_on: [winterbaume]
    environment:
      AWS_ACCESS_KEY_ID: test
      AWS_SECRET_ACCESS_KEY: test
      AWS_DEFAULT_REGION: us-east-1
      AWS_ENDPOINT_URL: http://winterbaume:5555
    command: ["s3api", "create-bucket", "--bucket", "errtraq-archive"]
    restart: "no"

  migrate:
    image: quay.io/lakekeeper/catalog:v0.15.1
    environment: &lk-env
      LAKEKEEPER__PG_ENCRYPTION_KEY: This-is-NOT-Secure!
      LAKEKEEPER__PG_DATABASE_URL_READ: postgresql://postgres:postgres@db:5432/postgres
      LAKEKEEPER__PG_DATABASE_URL_WRITE: postgresql://postgres:postgres@db:5432/postgres
      LAKEKEEPER__AUTHZ_BACKEND: allowall
    command: ["migrate"]
    depends_on:
      db:
        condition: service_healthy
    restart: "no"

  lakekeeper:
    image: quay.io/lakekeeper/catalog:v0.15.1
    environment: *lk-env
    command: ["serve"]
    healthcheck:
      test: ["CMD", "/home/nonroot/lakekeeper", "healthcheck"]
      interval: 1s
      timeout: 10s
      retries: 10
    depends_on:
      migrate:
        condition: service_completed_successfully
    ports:
      - "8181:8181"

  bootstrap:
    image: curlimages/curl
    depends_on:
      lakekeeper:
        condition: service_healthy
    restart: "no"
    command: ["-sS", "-X", "POST", "http://lakekeeper:8181/management/v1/bootstrap",
              "-H", "Content-Type: application/json",
              "--data", "{\"accept-terms-of-use\": true}"]

  create-warehouse:
    image: curlimages/curl
    depends_on:
      bootstrap:
        condition: service_completed_successfully
      create-bucket:
        condition: service_completed_successfully
    restart: "no"
    volumes:
      - ./docker/lakekeeper/warehouse.json:/home/curl_user/warehouse.json:ro
    command: ["-sS", "-X", "POST", "http://lakekeeper:8181/management/v1/warehouse",
              "-H", "Content-Type: application/json", "--data", "@warehouse.json"]
```

`docker/lakekeeper/warehouse.json`:

```json
{
  "warehouse-name": "errtraq",
  "storage-profile": {
    "type": "s3",
    "bucket": "errtraq-archive",
    "key-prefix": "warehouse",
    "endpoint": "http://winterbaume:5555",
    "region": "us-east-1",
    "path-style-access": true,
    "flavor": "s3-compat",
    "sts-enabled": false,
    "remote-signing-enabled": false
  },
  "storage-credential": {
    "type": "s3",
    "credential-type": "access-key",
    "aws-access-key-id": "test",
    "aws-secret-access-key": "test"
  },
  "delete-profile": { "type": "hard" }
}
```

Flags on the sketch:

- UNVERIFIED: credential field names. The 0.15 docs and getting-started page use `aws-access-key-id` / `aws-secret-access-key`. The `main` branch minimal example uses `access-key-id` / `secret-access-key`. Sources: https://docs.lakekeeper.io/docs/0.15.x/storage-s3/ , https://github.com/lakekeeper/lakekeeper/blob/main/examples/minimal/create-default-warehouse.json
- UNVERIFIED: Lakekeeper's storage validation passes against winterbaume. If `lakekeeper-read-write` fails, set `LAKEKEEPER__SKIP_STORAGE_VALIDATION=true` to isolate the cause. Source: https://docs.lakekeeper.io/docs/0.15.x/storage-validation/
- `sts-enabled: false` is deliberate: winterbaume would not enforce the downscoped session policy (section C).
- Endpoint reachability: Lakekeeper sees `http://winterbaume:5555`, a DuckDB process on the host sees `http://localhost:5555`. Lakekeeper returns its endpoint in the table config. UNVERIFIED which one DuckDB uses when `ACCESS_DELEGATION_MODE none` and an S3 secret are both present. Simplest fix: add `127.0.0.1 winterbaume` to `/etc/hosts`, or run the errtraq process inside the compose network.
- DuckDB side (sketch, UNVERIFIED as a whole):

```sql
INSTALL iceberg; INSTALL httpfs; LOAD iceberg; LOAD httpfs;
CREATE SECRET wb (TYPE s3, KEY_ID 'test', SECRET 'test', REGION 'us-east-1',
                  ENDPOINT 'winterbaume:5555', URL_STYLE 'path', USE_SSL false);
ATTACH 'errtraq' AS lake (TYPE iceberg, URI 'http://localhost:8181/catalog',
                          AUTHORIZATION_TYPE 'none', ACCESS_DELEGATION_MODE 'none');
SET iceberg_default_format_version = 3;
```

- UNVERIFIED: the catalog path `/catalog` under `http://localhost:8181` (not confirmed from a fetched page), and whether the default warehouse format-version policy allows v3.

## 8. Main unverified points (consolidated)

1. Basin Catalog (R2 Data Catalog) support for Iceberg v3 and deletion vectors, and whether its compaction and Basin SQL apply deletes.
2. Whether the DuckDB 2.0.0 extension binary includes the November `main` changes (`iceberg_expire_snapshots`, delete-file cleanup in `iceberg_rewrite_data_files`), and whether a rewrite is triggered by deletes alone.
3. DuckDB v3 DV writes against S3 Tables / Glue REST specifically. Glue REST docs still say v1/v2.
4. Lakekeeper: default format-version policy, open-source availability of the expire-snapshots / orphan-file / optimize queues, DV handling in Optimize.
5. winterbaume in the Lakekeeper + DuckDB role: validation passing, presigned URLs, chunked uploads, `--vfs-dir` in release binaries, container packaging.
6. `@duckdb/node-api` on Lambda: Node-specific confirmation and cold start numbers.
7. icebird: Workers compatibility, cross-engine validity of its v3 output, behavior with vended credentials.
8. S3 Tables compaction latency for DV-only changes and total time to physical deletion.
