# M3 AWS emulator probes

The baseline is Winterbaume source revision `69fed1d7fb0eb9a2738ff3274197c7591129c4cb`
(server 0.2.8). Its source archive is SHA-256 verified by `pnpm aws-emulator:install`;
the source, Cargo cache, build output and executable stay under `.agents-workspace/tmp`.
The first source build needs Rust and network access and is substantial (a debug build can
occupy tens of gigabytes); later test runs need neither network nor AWS credentials.

The following observations are from `pnpm test:aws-emulated`, using separate isolated
resources and a local in-memory server. They are behavioral smoke probes, not a guarantee
of complete AWS compatibility or a test of IAM, TLS, authentication, persistence,
concurrency, throttling, or eventual consistency. The test-only client routes requests
using dummy authorization; it is not a SigV4 implementation. It refuses non-loopback
endpoints. S3 uses path-style URLs.

| Service | Operation | Result |
| --- | --- | --- |
| S3 | Put, get and head | Pass |
| S3 | Ranged get | Pass |
| S3 | ListObjectsV2 continuation pagination | Pass |
| S3 | Conditional put (`If-None-Match: *`) | Pass |
| S3 | Single-part multipart upload and completion | Pass |
| S3 | Delete and missing object | Pass |
| DynamoDB | GSI query, ascending and descending | Pass |
| DynamoDB | Transaction condition check and abort atomicity | Pass |
| DynamoDB | Conditional update with `ADD` and `SET if_not_exists` | Pass |
| DynamoDB | BatchGetItem and consistent GetItem | Pass |
| DynamoDB | TTL attribute registration | Pass |
| SQS | Send, receive, delete and approximate receive count | Pass |
| SQS | Batch send | Pass |
| SQS | Change visibility and redelivery | Pass |
| SQS | Delayed delivery | Pass |
| SQS | DLQ redrive | Pass |

The harness also creates two independent namespaces using the module-derived eight-index
store and KV tables and SQS queue/DLQ shape, then verifies removal. Runtime values such as the test
visibility and redrive counts are chosen by the caller; cloud security settings such as
SSE and TLS-only policies are Terraform concerns and are not exercised by HTTP emulator
probes. TTL registration does not prove an asynchronous TTL sweeper. The namespace helper
is exported by `@errtraq/testing`; callers must always close it in a `finally` block.

The unmodified pinned server corrupts percent-encoded UTF-8 S3 keys; see
[WINTERBAUME_GAPS.md](./WINTERBAUME_GAPS.md). The S3 contract runs against a separate,
checksum-verified local source patch for that decoder. Other probes and Terraform integration
continue to use the unmodified pinned binary.

The latest server release binary tested, 0.2.6, returned the entire object with HTTP 200
for a range request. A separately signed AWS CLI request reproduced this. The pinned
newer source revision passes the range probe, so no S3 fallback is needed. No missing
DynamoDB or SQS feature in this probe set forces DynamoDB Local or ElasticMQ; use
Winterbaume for all three until a more demanding adapter contract demonstrates a gap.

## S3 runtime contract

`@errtraq/blob-s3` takes its bucket from `ERRTRAQ_BLOB_BUCKET` (or the staging
binding when only that purpose is supplied). Configuration accepts optional `region`,
`endpoint` and `forcePathStyle`; region otherwise comes from `AWS_REGION` or
`AWS_DEFAULT_REGION`. Lambda credentials are read from `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` and optional `AWS_SESSION_TOKEN` for each request, so refreshed
credentials are used. Explicit binding values are also accepted by the runtime constructor
for Web environments without Node globals. The default AWS endpoint uses virtual-hosted
addressing; use `forcePathStyle` for the local emulator.

The adapter signs in-memory payloads with their SHA-256 hash; bodyless requests use the
S3 unsigned-payload convention. Streams up to 5 MiB use a single PUT; larger
streams use 5 MiB multipart parts, retaining only a part for retry, up to 10,000 parts.
The write policy includes multipart abort; lifecycle remains the backstop. The portable
BlobStore contract rejects empty keys, keys over 1,024 UTF-8 bytes, control characters and
`.` or `..` path segments. A body-less HEAD 404 is treated as a missing key without an extra
bucket probe: S3 does not provide the error code in that response, and a probe may require
additional permissions. A GET 404 with `NoSuchBucket` raises `BlobBucketNotFoundError`.
The adapter rejects a non-advancing listing rather than silently returning repeated cursors.
The adapter applies a 10-second per-attempt request timeout and 30-second response-body idle
timeout by default, configurable with `requestTimeoutMs` and `bodyIdleTimeoutMs` (1 to 300,000
milliseconds). Retries use full jitter with a 500 ms base and honor `Retry-After`; an expired
token is retried once with refreshed credentials. Runtime list and key operations are limited to
the prefixes of the delivered primary and staging bindings; recovery lists `envelopes/`.

The unmodified emulator still runs all other probes. The separate patched build is only for
the S3 contract; installation requires Rust, network access, and substantial disk space,
even when the unmodified server has already been built.

## Terraform control-plane inventory

The same probe run exercised these representative operations, in addition to S3 bucket,
DynamoDB table and SQS queue creation and deletion. All passed against the pinned source:

| API | Observed operations |
| --- | --- |
| STS | GetCallerIdentity |
| IAM | CreateRole, GetRole, DeleteRole |
| Lambda | CreateFunction, GetFunction, DeleteFunction |
| Lambda function URL | CreateFunctionUrlConfig, GetFunctionUrlConfig, DeleteFunctionUrlConfig |
| Lambda event source mapping | Create, get and delete an SQS mapping |
| CloudWatch Logs | CreateLogGroup, DescribeLogGroups, DeleteLogGroup |
| EventBridge | PutRule, DescribeRule, DeleteRule |
| DynamoDB, SQS, S3 | Create and delete test resources, and read their state |

These results do not prove Terraform can apply the modules: provider discovery and every
other API, policy, tagging, waiter and update operation still need to be exercised by M3a2.
Control-plane probe failures are reported separately and do not fail the adapter probe gate.

## DynamoDB KV contract

`pnpm test:aws-emulated` runs the KV contract on isolated, module-shaped tables with TTL
enabled. An injected clock starts in 2090, so advancing it expires records logically while
the actual emulator clock and its asynchronous TTL sweeper leave the rows present. A direct
GetItem assertion verifies that logical expiration does not depend on physical deletion.
KV uses consistent GetItem reads, conditional UpdateItem with atomic ADD, PutItem and
DeleteItem. Winterbaume checks UpdateItem conditions separately from its backend write; see
[WINTERBAUME_GAPS.md](./WINTERBAUME_GAPS.md) for what the emulator cannot prove.
