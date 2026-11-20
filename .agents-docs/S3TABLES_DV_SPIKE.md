# Spike: DuckDB iceberg extension, S3 Tables, Iceberg v3 deletion vectors

Run on 2026-11-20 (UTC) against real AWS, region ap-northeast-1, in a shared staging account (`<account-id>`, profile `<aws-profile>`). Everything below was observed unless it is explicitly marked "inferred". Data was synthetic (user123@example.test style addresses, 2 x 20,000 rows). All resources were created with the prefix `errtraq-dvspike-` and deleted at the end (see Cleanup).

## 0. Versions

| Component | Version |
| --- | --- |
| DuckDB | v2.0.0 (via `@duckdb/node-api` 2.0.0-r.1, macOS arm64, Node v26.4.0) |
| iceberg extension | build 4c0c0874c4 (repository, as installed on 2026-11-20) |
| httpfs / avro / aws extensions | 77392a7207 / 345c3f4e82 / 16ae9c1353 |
| pyiceberg | 0.11.1 (pyarrow 26.0.1) |
| AWS CLI | 2.35.16 |

## 1. Connect (works)

```sql
INSTALL iceberg; INSTALL httpfs; INSTALL avro; INSTALL aws;
LOAD iceberg; LOAD httpfs; LOAD avro; LOAD aws;
CREATE SECRET s3s (TYPE s3, PROVIDER credential_chain, REGION 'ap-northeast-1');
ATTACH 'arn:aws:s3tables:ap-northeast-1:<account-id>:bucket/errtraq-dvspike-tb' AS tb
  (TYPE iceberg, ENDPOINT_TYPE s3_tables);
CREATE SCHEMA tb.ns1;
```

- Credentials: temporary credentials exported into the process environment (`aws configure export-credentials --format env`), picked up by `PROVIDER credential_chain`. No other ATTACH option was needed (`ENDPOINT_TYPE s3_tables` implies SigV4, warehouse = table bucket ARN).
- ATTACH took about 90 ms, CREATE SCHEMA about 40 ms, CREATE TABLE about 630 ms.
- Direct REST access with SigV4 (signing name `s3tables`, base `https://s3tables.ap-northeast-1.amazonaws.com/iceberg`, path prefix is the URL-encoded table bucket ARN, `GET /v1/config?warehouse=<encoded ARN>` returns `prefix`) works with botocore signing. A plain `curl --aws-sigv4` call failed with "The request signature we calculated does not match" (URL-encoded ARN in the path), so use botocore or the SDK.

## 2. Create a v3 partitioned table (works)

```sql
CREATE TABLE tb.ns1.events (
  project_id VARCHAR, event_id VARCHAR, issue_id VARCHAR, received_at TIMESTAMPTZ,
  user_email VARCHAR, archive_batch VARCHAR, payload VARCHAR
) WITH ('format-version' = 3);
ALTER TABLE tb.ns1.events SET PARTITIONED BY (day(received_at));
ALTER TABLE tb.ns1.events SET ('write.delete.mode' = 'merge-on-read');
ALTER TABLE tb.ns1.events SET SORTED BY (issue_id, received_at);
```

- `CREATE TABLE ... WITH ('format-version' = 3)` is accepted by S3 Tables; there is no CREATE TABLE ... PARTITIONED BY form in this build, so partitioning is a follow-up ALTER. `loadTable` afterwards: `format-version: 3`, `next-row-id` present (row lineage on), default properties `write.parquet.compression-codec=zstd`, `write.parquet.shred-variants=true`. `write.delete.mode` is NOT set by default (nothing means "merge-on-read" implicitly), so it must be set explicitly (accepted).
- After the ALTERs: partition spec 1 = `day(received_at)` (field `day_received_at_4`, field-id 1000), sort order 1 = `issue_id asc, received_at asc`, `default-sort-order-id: 1`. Spec 0 (unpartitioned) and sort order 0 remain in the metadata history.
- Sort order is declared AND honored by the DuckDB writer: data files carry `sort_order_id: 1` in the manifest and a local decode of one file showed 0 inversions of `issue_id` over 6,668 rows.
- Caveat (see section 7): doing the ALTER and the first INSERT in the same DuckDB process wrote the first batch with the OLD spec (unpartitioned). Run DDL in a separate session.

## 3. Append and idempotency probe (works)

```sql
INSERT INTO tb.ns1.events SELECT * FROM read_parquet('batch_A.parquet');  -- 20,000 rows, archive_batch='batch-A'
INSERT INTO tb.ns1.events SELECT * FROM read_parquet('batch_B.parquet');  -- 20,000 rows, archive_batch='batch-B'
```

- 501 ms and 877 ms. Each INSERT produced one snapshot (`operation: append`) with 3 data files (one per UTC day partition: 6,668 / 6,666 / 6,666 rows, about 70 KB each). 6 data files after two batches; the 3 projects share files (project is not a partition column).
- Snapshot summary keys: `added-data-files, added-files-size, added-records, deleted-data-files, deleted-records, total-data-files, total-delete-files, total-equality-deletes, total-files-size, total-position-deletes, total-records`. There is no way to set a custom summary property (`archive_batch` as a snapshot property is not possible through DuckDB; `iceberg_snapshots` exposes the summary as a key/value list).
- Probe: `SELECT count(*) FROM tb.ns1.events WHERE archive_batch = 'batch-B' AND received_at BETWEEN ... (one UTC day)` returned 6666 in 49 ms. `EXPLAIN ANALYZE` shows `Total Files Read: 1` out of 6 files, `Row Groups Scanned: 1 / 1`, one HTTP GET: partition pruning plus data-file column-stats pruning on `archive_batch` both work (batch_B in `day_received_at_4=20759` only).
- File listing via `iceberg_metadata(tb.ns1.events)` gives manifest_path, content (DATA / POSITION_DELETES), file_format, record_count, status.

## 4. Row-level DELETE writes real v3 deletion vectors (works)

`DELETE FROM tb.ns1.events WHERE project_id = 'proj-0' AND user_email = 'user7@example.test'` removed 66 rows (490 ms) spread over all 6 data files (11 per file).

Evidence, snapshot summary of the delete commit: `operation: delete`, `added-dvs: 6`, `added-delete-files: 6`, `added-position-deletes: 66`, `added-position-delete-files: 0`, `total-data-files: 6` (no data file was rewritten).

Delete manifest entries (read with `read_avro` on the delete manifest; paths trimmed):

```
content=1 (position deletes)  file_format=puffin  record_count=11  file_size_in_bytes=398
  file_path = <tbl>/data/day_received_at_4=20759/f25ce329-...-deletes.puffin
  referenced_data_file = <tbl>/data/day_received_at_4=20759/01a1f9e0-2c50-...parquet
  content_offset=4  content_size_in_bytes=62
```

Six such entries, one per affected data file, each with its own `.puffin` file holding one blob. Raw bytes of one Puffin file (read through `read_blob`): magic `PFA1`, blob, footer JSON `{"blobs":[{"type":"deletion-vector-v1","fields":[],"snapshot-id":-1,"sequence-number":-1,"offset":4,"length":62,"properties":{"referenced-data-file":"<tbl>/data/...parquet","cardinality":"11"}}]}`. So these are genuine `deletion-vector-v1` blobs. No v2 position-delete Parquet files, no rewritten data files. Note: one puffin file per data file (not one puffin with many blobs); allowed by the spec.

Visibility: a fresh DuckDB process read 39,934 rows (40,000 minus 66), target rows 0; `pyiceberg` (section 5) agrees.

Merge test: DELETE of `proj-0 / user8@example.test` (67 rows) hit the same 6 files. Summary: `added-dvs: 6, removed-dvs: 6, removed-delete-files: 6, total-delete-files: 6, total-position-deletes: 133`. In the manifest the 6 old entries went to status 2 (DELETED) and 6 new ones (status 1) point to the same data files with `record_count` 22 or 23 (cumulative) and a larger blob (`content_size_in_bytes` 84 or 86 instead of 62). Result: still exactly one DV per data file (merged), as the spec requires. This held through about 20 successive deletes (final state 6 puffin files for 6 data files, cardinality sum 873).

`DELETE ... WHERE event_id IN ('ev-A-000001','ev-A-000002','ev-B-000010','ev-B-019999','ev-nonexistent')` deleted 3 rows (one id had already been removed by an earlier user delete), touching only 2 files: `added-dvs: 2, removed-dvs: 2, total-delete-files: 6`. Count went 39,130 to 39,127, targets 0 afterwards.

Timing: each DELETE 430 to 800 ms (including the REST commit) on 40,000 rows. Deletes of 0 matching rows commit nothing (Count 0).

A row inserted AFTER a delete with the same e-mail is not masked (my later 8 small appends re-added 8 rows for the deleted user and both readers show them, as expected).

## 5. Second reader

| Reader | Result |
| --- | --- |
| Fresh DuckDB process (new ATTACH) | Works, deletes honored (counts above) |
| pyiceberg 0.11.1 with REST SigV4 (`rest.signing-name=s3tables`, warehouse = table bucket ARN) and S3 credentials | Works: `format_version 3`, `scan().to_arrow()` returned 39,127 rows right after the event_id delete and 43,927 rows after the later appends, identical to DuckDB, deleted users absent |
| Amazon Athena | Untested. Needs the S3 Tables integration with Glue / Lake Formation, which the task forbade enabling; AWS docs (not verified here) say Athena cannot read v3 |
| Glue REST endpoint, Spark/EMR | Untested |

## 6. Physical erasure

### 6a. On-demand rewrite from DuckDB: fails for v3

```
CALL iceberg_rewrite_data_files(tb.ns1.events);
Not implemented Error: iceberg_rewrite_data_files does not yet support V3 tables
```

Same error with `rewrite_all := true`. There is no `iceberg_expire_snapshots`, orphan-file or rewrite-manifests function in this build (function list: iceberg_bucket, column_stats, files, history, load_table_response, manifests, metadata, partition_specs, partition_stats, refs, rewrite_data_files, rollback_to_snapshot, scan, scan_plan, scan_tasks, schema_properties, snapshots, table_properties, to_ducklake, truncate, view_metadata, plus set/remove property functions). `ALTER TABLE ... SET ('format-version' = 2)` on a v3 table: `Cannot downgrade format-version from 3 to 2`.

Comparison on a v2 table (same shape, v2 positional-delete Parquet files): `CALL iceberg_rewrite_data_files(tb.ns1.events_v2, rewrite_all := true)` worked against S3 Tables: `rewritten_data_files 7, added_data_files 3, rewritten_bytes 298421`, snapshot `operation: replace`, deleted rows gone from the new files (0 rows for the deleted user in the 3 new files). The v2 delete Parquet files stayed listed in the metadata (`total-delete-files: 9` after the rewrite), so the "drop delete files in the same REPLACE commit" behavior from the desk research was not observed in this build. A v2 table upgraded in place with `ALTER TABLE SET ('format-version' = 3)` accepts further DELETEs as Puffin DVs (mixed old Parquet delete files plus new DVs, not merged), but then also refuses rewrite.

### 6b. S3 Tables automatic maintenance

Defaults observed on a new table bucket and table:

- Table: `icebergCompaction` enabled, `targetFileSizeMB 512`, `strategy auto`; `icebergSnapshotManagement` enabled, `minSnapshotsToKeep 1`, `maxSnapshotAgeHours 120`.
- Bucket: `icebergUnreferencedFileRemoval` enabled, `unreferencedDays 3`, `nonCurrentDays 10`.

I lowered them (all accepted by `put-table-maintenance-configuration` / `put-table-bucket-maintenance-configuration`): `maxSnapshotAgeHours 1`, `minSnapshotsToKeep 1`, compaction `targetFileSizeMB 64` + `strategy binpack`, `unreferencedDays 1`, `nonCurrentDays 1`. One hour and one day are the documented minimums; shorter is not possible.

What actually ran (job status polled for about 19 minutes):

- Compaction: ran once on its own at 16:54:23Z (about 1 minute after the two appends, status Successful) and produced NO snapshot (6 small files, nothing rewritten). It did not run again in the following 26 minutes, including after I changed its settings and after I added 8 more tiny appends (24 small files, 24 snapshots in total). So compaction is not a dependable on-demand trigger: no way to start a run via API was found (no `start` call exists in the CLI), and the schedule is not documented.
- Unreferenced file removal: ran at 16:57:55Z (Successful, nothing to remove).
- Snapshot management: ran at 17:00:07Z (Successful); it expired nothing because all snapshots were under 1 hour old, so snapshot expiry could not be observed within the time budget.

Result: it was NOT observed that S3 Tables maintenance applies DVs and physically removes the rows. That claim stays unverified. (The AWS docs claim it; from what was seen, expect latency of at least: compaction schedule unknown + 1 hour snapshot age + 1 day noncurrent, if everything works.)

### 6c. Byte-level inspection

- Direct object read is possible with the same credentials: `read_blob('s3://<underlying table bucket>/data/...parquet')` and `read_parquet` on the file paths from `iceberg_metadata` both work (admin role; the table location bucket name is an opaque generated name, not the table bucket name). I downloaded files through `read_blob` + base64. Whether a least-privilege role can do this was not tested (S3 Tables normally needs `s3tables:GetTableData`; inferred).
- After the DV-only delete the e-mail is still physically in the data files: decoding each of the 6 data files with `read_parquet` shows 11 rows per file for `proj-0 / user7@example.test` (66 in total), exactly the rows masked by the DVs. A raw byte search for `user7@example.test` in the files returned false for every file of the real size: the Parquet column chunks are zstd-compressed and dictionary-encoded, so a literal byte scan gives false negatives (it only hit a 1,665-byte file where the value was stored uncompressed). To prove erasure, decode with `read_parquet` or decompress; do not grep raw bytes.
- v2 table after on-demand rewrite: the 3 new data files contain 0 rows for the deleted user, but the 7 OLD data files were still readable by path and still contained all 33+11+11+11 original rows for that user (old snapshots reference them). Physical removal therefore needs snapshot expiry plus unreferenced file removal after the rewrite; neither is available from DuckDB in this build, only through S3 Tables maintenance (not observed to finish in time). I could not delete the files myself (S3 Tables objects are managed; `s3.delete-enabled=false` in the catalog config).
- For v3 there was no rewrite at all, so "gone after the rewrite" could not be shown.

## 7. Surprises and failures (exact text)

1. Same-session read-after-write is stale by default. Within one DuckDB session after an INSERT or DELETE commit, a SELECT returns the old state, a following DELETE can conflict, and DDL (SET PARTITIONED BY) followed by INSERT used the old partition spec. Exact error on back-to-back DELETEs in one session (reproduced 4 times):
   `TransactionContext Error: Failed to commit: Failed to commit Iceberg transaction: DELETE on "events" conflicts with a concurrent commit (scanned snapshot 2911708745328118126, now at 8842133163713317021); re-run the DELETE. Set 'write.delete.isolation-level'='snapshot' to allow re-applying deletes over concurrent appends.`
   Cause (inferred, strongly supported): `iceberg_use_metadata_log` defaults to true and selects table metadata "as of the transaction start" by timestamp, which hides the session's own just-committed snapshot (server timestamps vs local clock). `ATTACH ... MAX_TABLE_STALENESS '0 seconds'` did NOT fix it. `SET iceberg_use_metadata_log = false;` DID: reads saw own commits (40000 to 40010 after INSERT, 40010 to 39944 after DELETE) and 3 consecutive DELETEs plus INSERTs ran without conflict. A fresh process (new ATTACH) per operation also works. A SELECT between two DELETEs avoided the conflict in 2 of 2 trials but the count it returned was still stale.
2. `iceberg_rewrite_data_files` does not support v3 (above). This is the main blocker.
3. No custom snapshot summary properties (above); `archive_batch` column plus partition-pruned probe is the only idempotency channel via DuckDB.
4. Writes alter 1 or 2 manifests plus 1 manifest list per commit; metadata growth is linear in commits. 24 snapshots after this spike; each DELETE commit adds a snapshot, so a per-request erasure design grows the snapshot list.
5. IAM actions seen in CloudTrail for the Iceberg REST traffic of this run (observed): `s3tables:GetTableMetadataLocation`, `UpdateTableMetadataLocation`, `GetTableBucket`, `ListNamespaces`, plus the maintenance get calls I issued. Data-file reads and writes use S3 data access (`GetTableData`/`PutTableData`, inferred, not seen in management-event CloudTrail). The role used was admin, so least-privilege was not tested.
6. S3 Tables REST caveats confirmed or consistent with docs: CREATE TABLE works without staging (DuckDB sets `STAGE_CREATE_TABLES false` for this endpoint type); CTAS not tried.
7. `create-table-bucket` returned the ARN immediately; `delete-table` and `delete-table-bucket` succeeded without needing to remove data files first.

## 8. Verdict

| Capability | Verdict |
| --- | --- |
| Connect DuckDB 2.0.0 to S3 Tables REST (SigV4) | works |
| v3 table create (`WITH ('format-version' = 3)`) | works |
| Partition `day(received_at)`, sort order, `write.delete.mode` | works (via ALTER, separate session) |
| Append 2 x 20,000 rows, partition-pruned probe | works (probe prunes to 1 of 6 files) |
| Custom snapshot summary property | fails (not supported by DuckDB) |
| DV delete (user selector, event_id IN) | works (genuine Puffin `deletion-vector-v1`) |
| DV merge on repeated delete | works (one DV per data file) |
| Second reader: fresh DuckDB, pyiceberg | works |
| Second reader: Athena, Spark/EMR, Glue REST | untested |
| On-demand rewrite from DuckDB for v3 | fails (`does not yet support V3 tables`); works on v2 |
| S3 Tables automatic maintenance default config, lowering retention | works (accepted; min 1 hour / 1 day) |
| S3 Tables maintenance applying DVs and removing bytes | untested (compaction ran once with no effect, did not re-run in 26 minutes; snapshot expiry not reachable within an hour) |
| Byte-level verification | works for presence (decode with read_parquet), absence after rewrite untested for v3 |

## 9. Implications for the errtraq design

What ARCHITECTURE.md gets right:

- Format v3 plus merge-on-read: DuckDB 2.0.0 does write real Puffin DVs against S3 Tables, merged per data file, visible to other readers immediately. The `capabilities.rowDelete: 'deletion-vector'` value is correct for this stack.
- `deleteWhere` returning `{snapshotId, rowsDeleted, files}` is feasible: the affected data files are the `referenced_data_file` values of the new delete manifest entries (read via `iceberg_metadata` / `read_avro`), and the snapshot id comes from `iceberg_snapshots` or the REST commit response. Single-project files are still unproven (rows of 3 projects shared every file here), so a selector delete touched every file of the partition range; expect this to apply to the real design only if the archival job really writes one project per file.
- Idempotency via an `archive_batch` column plus a partition-pruned count works (1 file read). Partition-only `day(received_at)` is fine.
- The "DV masks, bytes remain" statement is confirmed byte-for-byte.

What must change:

1. `hardErase` cannot be `iceberg_rewrite_data_files` on a v3 table in DuckDB 2.0.0. Options: (a) rely on S3 Tables compaction and snapshot management (not observed to complete, no on-demand trigger found), (b) copy-forward into a new table (INSERT the live rows of the affected partitions into a fresh v3 table, swap, drop the old one; not tried), (c) keep the archive table at v2 so that `iceberg_rewrite_data_files` works (verified on v2) and give up DVs (v2 positional-delete Parquet files, and the table cannot be downgraded later), (d) wait for DuckDB to support v3 rewrite. The physical-erase SLA must not promise a bound until (a) is measured over multiple days.
2. `expireSnapshots` has no DuckDB implementation here; it must be done by S3 Tables maintenance (`maxSnapshotAgeHours` min 1) or a direct REST commit (`remove-snapshots` through the catalog, not tried). Unreferenced file removal has a 1 day minimum after expiry, so the earliest realistic physical deletion is at least about 1 day plus the compaction latency.
3. The DuckDB `ArchiveStore` adapter must work around stale same-session reads: `SET iceberg_use_metadata_log = false` or a fresh ATTACH per operation, plus retry on "conflicts with a concurrent commit" (also needed because compaction can race writes). Run DDL (partition/sort setup) in a separate process before first insert.
4. `append` cannot attach `batchId` to the snapshot; the probe must stay column-based.
5. `hardErase` verification should decode Parquet (not byte-grep) and should be a check on the file list returned by `deleteWhere`, since old files stay readable until unreferenced-file removal.

## 10. Untested

- Athena, Glue REST, Spark/EMR as readers; any reader other than DuckDB and pyiceberg.
- S3 Tables compaction or snapshot expiry actually removing DV-masked rows (needs more than 1 hour wait; compaction schedule unknown).
- Copy-forward swap (rename/drop) as a physical erasure path; REST `remove-snapshots`.
- Least-privilege IAM, Lake Formation integration, concurrent compaction versus delete conflicts, and larger data volumes.
- Parquet bloom filters, `write.target-file-size-bytes` effects, UPDATE and MERGE on v3.

## 11. Cleanup

Created: table bucket `errtraq-dvspike-tb`, namespace `ns1`, tables `ns1.events` (v3) and `ns1.events_v2`. No staging S3 bucket, Glue, Lake Formation or account-level settings were created or changed. All were deleted at the end (`delete-table` x2, `delete-namespace`, `delete-table-bucket`); afterwards `list-table-buckets --prefix errtraq-dvspike` returned an empty list and `get-table-bucket` / `list-tables` returned NotFoundException. Local scratch files (synthetic Parquet copies, scripts) remain only in the scratchpad work directory outside the repository.
