# M4d: local archive environment and the Lakekeeper + winterbaume spike

Date: 2026-11-25. Scope: environment and spike only, no product code. Run with `pnpm archive:smoke`
(`node scripts/archive-local/smoke.mjs`); the run takes about 30 seconds after the images are cached.

## Environment (everything in containers, nothing installed on the host)

`docker/archive/compose.yaml`, one compose network, project `errtraq-archive-smoke` when run by the smoke command.

| Service | Image / source | Pin |
| --- | --- | --- |
| db | `postgres:17.12` | sha256:87c8b42f423b45d5247e6aa8fdb2e7762fec164c68a50fe3eb07e7bfcaf4dbcf (arm64) |
| migrate, lakekeeper | `quay.io/lakekeeper/catalog:v0.15.1` | sha256:22dcb6044c106a962c242b70051bd226bd50c9134c763121d8713c37fe9a70ec (arm64), `migrate` then `serve`, `LAKEKEEPER__AUTHZ_BACKEND=allowall` |
| winterbaume | `debian:bookworm-slim` (sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e) with the winterbaume-server v0.2.9 linux aarch64 binary bind-mounted read-only | binary from the checksum-verified archive (sha256 bc62e118...b7ec996), runs on glibc of bookworm, flags `--host 0.0.0.0 --port 5555 --region us-east-1` (same flags as `scripts/aws-emulated/run.mjs`) |
| runner | `docker/archive/runner/Dockerfile`, `node:26.13.1-bookworm-slim` (sha256:0042e17d...54798c9) | `@duckdb/node-api@2.0.1-r.1` (npm `latest`; DuckDB v2.0.1; the earlier spike used 2.0.0-r.1) installed inside the image only; `iceberg`, `httpfs`, `avro` extensions are downloaded at runtime inside the container |

Platform: every service carries `platform: ${ARCHIVE_PLATFORM:-linux/arm64}` because the pinned binary is aarch64 (Apple Silicon runs it natively).
On an amd64 host set `WINTERBAUME_LINUX_BINARY` to the x86_64 build; the smoke command then selects `linux/amd64` itself.
There is no linux entry in `scripts/aws-emulated/install.mjs` yet; the smoke command looks for the extracted binary under
`.agents-workspace/tmp/winterbaume-server-v0.2.9/bin-linux/...` or `WINTERBAUME_LINUX_BINARY`, and SKIPs with instructions otherwise.
The smoke command also SKIPs (exit 0) when Docker or the compose plugin is missing (verified with an empty PATH).

Files: `docker/archive/compose.yaml`, `docker/archive/runner/Dockerfile`, `scripts/archive-local/smoke.mjs` (host orchestrator:
up, bootstrap, spike, per-question PASS/FAIL, winterbaume traffic summary, `compose down -v` in `finally` and on SIGINT/SIGTERM),
`scripts/archive-local/container/{lib,bootstrap,spike}.mjs` (run inside the runner), root `package.json` script `archive:smoke`.
Not part of `pnpm test`.

Bootstrap: `PUT /errtraq-archive` on winterbaume (needs a SigV4-looking `Authorization` header so the request routes to S3, the
signature is never verified), `POST /management/v1/bootstrap`, then `POST /management/v1/warehouse` with an `s3` storage profile:
`bucket errtraq-archive`, `key-prefix warehouse`, `endpoint http://winterbaume:5555`, `region us-east-1`, `path-style-access true`,
`flavor s3-compat`, `sts-enabled false`, access-key credential `test`/`test`.

DuckDB session: `INSTALL/LOAD httpfs, avro, iceberg`; `CREATE SECRET (TYPE s3, KEY_ID, SECRET, REGION, ENDPOINT 'winterbaume:5555', URL_STYLE 'path', USE_SSL false)`;
`ATTACH 'errtraq' AS lk (TYPE iceberg, ENDPOINT 'http://lakekeeper:8181/catalog', AUTHORIZATION_TYPE 'none', ACCESS_DELEGATION_MODE 'none')`;
`SET iceberg_use_metadata_log = false`. DDL runs in its own session before the first INSERT (S3Tables spike finding).

## Answers

1. Warehouse creation passes Lakekeeper storage validation against winterbaume: YES. HTTP 201 on the first try with the profile above
   (validation does PUT, HEAD, GET, DELETE of `metadata/test` plus two ListObjectsV2 calls, all served). With the bucket missing the
   failure is the expected `Storage validation failed [lakekeeper-read-write] ... The specified bucket does not exist` (so validation is real, not skipped).
   No `LAKEKEEPER__SKIP_STORAGE_VALIDATION` needed. The returned profile has `push-s3-delete-disabled: true` and `remote-signing-enabled: true`
   (DuckDB ignores the signer config with `ACCESS_DELEGATION_MODE none`).
2. DuckDB 2.0.1 through Lakekeeper: YES for ATTACH, CREATE SCHEMA, CREATE TABLE `WITH ('format-version' = 3)` and `= 2`, INSERT, DELETE, read back.
   Evidence from the run: loadTable reports `format-version` 3 and 2; `SET PARTITIONED BY (day(received_at))`, `SET SORTED BY (project_id, issue_id, received_at)`
   and `SET ('write.delete.mode' = 'merge-on-read')` are accepted and stored (partition spec 1 `received_at_day`, sort order 1 with three identity fields).
   v3 DELETE (`user_email = ...`, 518 rows) produced 4 delete files with `content POSITION_DELETES` and `file_format puffin`, snapshot summary
   `added-dvs 4, added-position-deletes 518, added-position-delete-files 0`: these are real deletion vectors; reads show 0 rows for that user and 49,682 total.
   v2 DELETE produced 3 positional-delete files with `file_format parquet` (21 rows). `iceberg_rewrite_data_files` is `Not implemented ... does not yet support V3 tables`
   (as in the S3 Tables spike); on v2 it works against Lakekeeper (3 data files rewritten, 3 delete files removed).
   `iceberg_use_metadata_log`: with `false` an INSERT is visible in the same session. With the default `true` it was ALSO visible here (10 of 10), so the
   S3 Tables stale-read symptom did not reproduce against Lakekeeper (the staleness there was attributed to server timestamps vs the local clock; here all containers share the host clock).
   Keep `SET iceberg_use_metadata_log = false` anyway (TODO item stays valid for S3 Tables).
3. Lakekeeper format-version policy: a new warehouse reports `allowed-format-versions [1,2,3]` and both v2 and v3 tables were created through it. No policy change needed.
   The response has no explicit default-format-version field; DuckDB passes the version explicitly.
4. Maintenance task queues in the open-source image: NO. `GET /management/v1/info` lists `queues: [soft_deletion, tabular_purge, task_log_cleanup]` (license `Apache-2.0`, `lakekeeper-core`).
   `GET/POST /management/v1/warehouse/{id}/task-queue/{expire_snapshots|remove_orphan_files|optimize}/config` all return 404 `QueueNotFound`.
   So locally there is no catalog-side snapshot expiry, orphan removal or compaction: those are Lakekeeper Plus features (matches issue #1620).
   Consequence for M4e/M4l: local `expireSnapshots` must come from errtraq itself (REST `remove-snapshots` commit through M4e, or DuckDB `iceberg_expire_snapshots` once released),
   and physical file removal is not available locally for v3; v2 can use `iceberg_rewrite_data_files`.
5. winterbaume under DuckDB traffic: STABLE. 50,000 rows (about 48.7 MB of Parquet in 3 files of about 16.2 MB, partitioned by day) inserted in 0.8 s;
   winterbaume saw 3 multipart uploads (`POST ?uploads`, 9 part PUTs, 3 completes) and 112 ranged GETs (HTTP 206), no 5xx. Integrity: `sum(hash(event_id || payload))` of the generated rows
   equals the same checksum read back by a fresh session through winterbaume (multipart written, range read). Direct probe: `Range: bytes=N-M` returns 206 with a correct
   `Content-Range`, suffix range `bytes=-4` returns `PAR1`; `read_blob` length equals `HEAD` content-length. No winterbaume defect was found.
6. M4b operations on a table partitioned by `day(received_at)` and sorted `(project_id, issue_id, received_at)` (D13): all work.
   `hasBatch` as a day-ranged `count(*) WHERE archive_batch = ?` returns the batch size (50,000) and 0 for an unknown batch; `EXPLAIN ANALYZE` shows `Total Files Read: 3` for a
   whole-table batch predicate and `1` with a one-day `received_at` range (partition pruning works on a TIMESTAMPTZ day transform); `batchEventIds` (`SELECT event_id ... WHERE archive_batch = ? AND day range`)
   returned exactly the 200 ids of a second batch; a decode of one data file shows 0 sort-order inversions, so DuckDB honors the sort order on write.

## Defects and quirks (none blocking)

- winterbaume: an UNSIGNED `PUT /errtraq-archive` (no `Authorization` header) returns 404 (observed in its request log as `status=404`; response body not captured). Real S3 answers an anonymous request
  with 403 AccessDenied. Repro for an upstream issue: start `winterbaume-server --host 0.0.0.0 --port 5555`, run `curl -i -X PUT http://localhost:5555/some-bucket`, expect 403/200 depending on policy, observe 404 (no service match without a SigV4 header).
  Harmless for errtraq because SDKs always sign.
- DuckDB: `lambda x -> ...` is rejected in 2.0.1 (use `lambda x: ...`); relevant to any SQL errtraq generates.
- Lakekeeper OSS lacks the maintenance queues (finding 4); `push-s3-delete-disabled: true` is the default for this storage flavor.

## D11 (fallback if Lakekeeper rejects winterbaume)

Not triggered: validation passed. If a future winterbaume or Lakekeeper release regresses: (1) first try `LAKEKEEPER__SKIP_STORAGE_VALIDATION=true` as a stop-gap (documented knob, validation only),
(2) fix upstream in winterbaume (the owner maintains it), (3) as a temporary gate run the engine tests against a REST catalog stub plus real AWS, as D11 already says. No second S3 server is proposed (CLAUDE.md forbids MinIO).

## What M4e and M4f should assume

- The opt-in environment is `docker compose -p <name> -f docker/archive/compose.yaml up -d --build --wait` with `WINTERBAUME_BINARY` set; Lakekeeper REST base `http://lakekeeper:8181/catalog` (host access requires publishing the port, which the compose file does not do; tests that run from the host need a `ports:` override or should `exec` into the runner),
  warehouse `errtraq`, bucket `errtraq-archive`, static S3 credentials `test`/`test`, path style, `ACCESS_DELEGATION_MODE none`.
- Table: v3 supported end to end (DVs), v2 as an option; DDL in a separate session; D13 sort order and `day(received_at)` partitioning verified.
- Local erasure: DV delete works; there is no local v3 rewrite or catalog maintenance, so M4l's physical-erase path must be exercised on v2 locally (rewrite works) or through REST `remove-snapshots` that M4e implements.
- M4e: the REST client talks to Lakekeeper with no auth (`allowall`); table config returns `s3.endpoint`, `s3.path-style-access`, `s3.region` and remote-signing hints, no vended credentials.
- Idempotent probe pattern from M4b works as designed (column plus day-pruned count).
