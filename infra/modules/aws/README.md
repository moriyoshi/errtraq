# AWS module contracts

These modules are declarative infrastructure, not implemented AWS runtime adapters. Lambda
artifacts are ZIP files; `filename` is resolved relative to the generated Terraform root.
`runtime` and `handler` default to `nodejs22.x` and `index.handler`, and the builder must match
them. Direct Lambda ZIP uploads have a size limit; an S3 deployment path is M3 work.

Each HTTP function explicitly selects `NONE` or `AWS_IAM` authorization. The default is `NONE`
for both ingest and API: the URL is public, while errtraq checks DSN keys or API bearer tokens.
Use `AWS_IAM` for signed callers where appropriate; ordinary Sentry SDKs cannot sign IAM requests.
An optional per-function reserved concurrency limits cost (zero disables the function). Ingest
URLs configure Lambda CORS for the same methods and headers as the ingest app. Lambda also adds
CORS response headers, so M3 must ensure the generated Lambda handler suppresses the app's
corresponding headers to prevent duplicates; standalone keeps its existing app CORS.

Each function role receives its derived policy documents, scoped Secrets Manager reads, and
permissions to write its own log group. The module checks the total compact inline policy size
against IAM's 10,240-character role limit. For the current per-topic stack and representative
maximum-length resource names, ingest / API / consumer / cron use about 2104 / 1408 / 2440 /
1295 characters respectively including logging, with no secrets. No managed-policy switch is
needed at those sizes. The guard enforces the real size when resource values resolve. Secret
identifiers must be complete Secrets Manager ARNs, including the generated suffix. A
customer-managed encryption key also needs its own KMS key policy or grant.

EventBridge uses UTC schedules; the current module accepts five-field Unix schedules with a
wildcard day of week. The target passes `{ "job": name }`, with configurable retry attempts,
maximum event age and optional external SQS DLQ ARN. The operator must grant the EventBridge
service permission to send to that DLQ. M2c dispatches the event to the cron handler. SQS event
source mappings request partial batch failure responses and check visibility against Lambda's
function timeout; core additionally enforces its six-times safety factor. The M3 queue handler
must return partial failures.

The DynamoDB store table uses `PK` / `SK`, with project records under `P#<project>` and
entity-specific sort keys. M3 must create and maintain lookup and index items atomically
alongside the canonical records. Natural-key aliases provide organization and project slug,
project key, token hash, release version and debug-id lookups; a global issue-id partition
serves cross-project issue lookup, and a project-list partition serves project enumeration.
Sparse index items make both all-status and specific-status issue queries possible. The eight
store indexes are:

| Index | Query |
| --- | --- |
| gsi1 | Issue list by project and optional status, ordered by lastSeen, including time ranges. |
| gsi2 | Issue list by project and optional status, ordered by firstSeen. |
| gsi3 | Issue list by project and optional status, ordered by count. |
| gsi4 | Events by project and issue in receivedAt / eventId order. |
| gsi5 | Events by project in receivedAt / eventId order, including the archival cutoff scan. |
| gsi6 | Events by project, subject kind and value for bounded erasure; event-id selectors use direct keys. |
| gsi7 | Issue fingerprint within a project. |
| gsi8 | Erasure requests by project and/or state, including cross-project state queries. |

M3 must encode sort keys for the documented tie-breaks and create separate index items where
a record needs more than one partition key, such as all-status versus status-specific views,
multiple subject identities, and project-only versus state-only erasure queries. Project / status
and state / project index fan-out must be maintained transactionally with their source records.
GSI reads are eventually consistent; M3 must account for that limit in its port implementation
and tests. KV uses the same table module without store indexes. `expiresAt` is a numeric epoch
seconds TTL attribute and is set only on items intended for expiration. The store's explicit
PII erasure must not wait for TTL. Point-in-time recovery is enabled, and operators must manage
backup retention in any hard-erasure procedure. The `read` policy assumes GetItem, BatchGetItem
and Query; `write` assumes PutItem, UpdateItem and transaction condition checks; `delete` assumes
DeleteItem or transaction Delete operations. `BatchWriteItem` is deliberately not granted because
it can also put items. M3 must implement deletion accordingly.

SQS physical queues are keyed maps, each with independent visibility and DLQ settings. The
DLQ retains messages for 14 days and the source queue retains them for four. S3 blocks public
access, denies non-TLS requests, enforces bucket ownership, uses SSE-S3, and leaves versioning
disabled so ordinary object deletion does not retain old object versions. Primary permissions
cover the current `envelopes/`, `payloads/`, and reserved `artifacts/` namespaces; staging
permissions cover only the configured staging prefix. New primary namespaces require policy
updates. Abandoned envelopes expire after 14 days by default and archive staging after seven;
operators must choose retention periods longer than their recovery windows. Incomplete multipart
uploads are aborted after seven days. No fixed lifecycle expiry applies to durable overflow
payloads: event retention is project-specific and premature deletion would lose live event data.
M3 / M4 must remove them when the corresponding events are retained, archived or erased.
`protection` defaults to `production`: DynamoDB deletion protection is on and bucket force
teardown is off. An explicit `disposable` stack allows both to be destroyed.

Blob `read` includes prefix-scoped `ListBucket` to distinguish a missing key. S3 can still return
403 for GetObject / HeadObject when a prefix condition is in use. The M3 adapter must never
interpret a 403 as missing; it must probe with an allowed exact-prefix ListObjectsV2 request and
return null only when absence is established, otherwise propagate the authorization failure.
Deployed cron requires primary blob read / list and ingest-queue produce to recover staged
envelopes; M3 must schedule and implement that recovery. Standalone already recovers at startup.

Output descriptions carry `errtraq-type` and `errtraq-keys` declarations because HCL output
blocks have no type constraint. The default TypeScript contract test compares these declarations
with the descriptors; Terraform mock-provider tests independently check the actual output shapes
and encoded policy leaves. Keep all three in sync when changing module outputs.
