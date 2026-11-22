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

The DynamoDB store table uses `PK` / `SK`, with distributed `EV|project|eventId` event
keys and `IS|project|issueId` issue keys. The M3 runtime must maintain natural-key markers and
one strong issue-ID pointer per issue alongside the canonical records. Sparse GSI attributes
live on their source items and their indexes are eventually consistent. Natural-key aliases
provide organization and project slug, project key, token hash, release version and debug-ID
lookups; an issue-ID pointer partition serves cross-project issue lookup.
The store has eleven sparse, `KEYS_ONLY` GSIs: `event-project-time`,
`event-issue-time`, `issue-id`, `issue-last`, `issue-first`, `issue-count`,
`entity-list`, `erasure-all`, `erasure-project`, `erasure-state`, and
`erasure-project-state`. Their exact string attributes live in `dynamodb/indexes.json`.
See `.agents-docs/DYNAMODB_DESIGN.md` for the key encodings, per-operation access
patterns, eventually consistent hydration and the strong issue-ID pointer. No subject
index is stored in DynamoDB. KV has no GSIs and keeps its numeric `expiresAt` TTL;
the store uses numeric `ttlEpoch`, distinct from the domain's ISO `expiresAt`.

The redesigned store table uses the versioned name `<stack>-store-v2`, so upgrading an old
layout cannot silently rewrite its indexes in place. Migrating data and Terraform state needs
an explicit reviewed operation. An existing-store selection is an operator promise that the
external table already has this layout and metadata; stack validation cannot inspect it.
KV retains its `<stack>-kv` name. The store creates a
`META|schema` / `DATA` item recording `index_shards` (default 4,
range 1 to 4). Terraform preserves the initial count and rejects later changes; actual
re-sharding or migration of an older table requires a reviewed backfill and state migration.
Production metadata also has `prevent_destroy` so a refused protected-table destroy cannot
first delete the metadata. Switching production to disposable needs an explicit state
migration rather than an implicit replacement. Readers must use the persisted shard count.
The Terraform execution principal needs permission to read, put and delete this metadata
item; those provisioning permissions are separate from function-role grants.

The store read policy grants GetItem, BatchGetItem and Query on the table and named indexes;
write grants GetItem, PutItem and UpdateItem, without DeleteItem or a stage-4 fence check.
Event deletion grants BatchWriteItem only for `EV|` keys; this action can also put event
items, so it must be given only to roles that delete events. The policy cannot distinguish a
put from a delete in a batch. AWS applies `dynamodb:LeadingKeys` to every item in a
batch: [DynamoDB fine-grained IAM conditions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html).
Separate metadata-delete grants DeleteItem constrained by
`dynamodb:LeadingKeys` to the listed metadata namespaces. KV write and delete continue to
use their existing PutItem/UpdateItem/GetItem and DeleteItem policies. PITR can retain erased
bytes after deletion; operators must account for backup retention.

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

CloudWatch alarms are always created, with no topic or subscription. The SQS module has one
`<stack>-<queue>-dlq-messages` alarm per enabled DLQ (`AWS/SQS` `ApproximateNumberOfMessagesVisible`,
maximum, five-minute period, one of one datapoint, greater than 0) and one `<stack>-<queue>-queue-age`
alarm per physical source queue (`ApproximateAgeOfOldestMessage`, maximum, five-minute period, three of
three datapoints, greater than 900 seconds, so a stuck consumer is reported after about 15 minutes;
a poison message under the default redrive is dead-lettered before then). The Lambda module has one
`<stack>-<function>-errors` alarm per physical function (`AWS/Lambda` `Errors`, sum, five-minute period,
one of one datapoint, greater than 0; partial batch item failures are not function errors). Dimensions
are the real queue or function names, so FIFO queues and DLQs carry `.fifo`; shared queues have one
alarm set. Missing data is `notBreaching` everywhere: SQS emits no datapoints for an idle queue and
Lambda none without invocations. The optional `alarm_topic_arn` (stack config `alarmTopicArn` on
the SQS adapter and the Lambda platform) is a validated SNS topic ARN owned by the operator; when set
it is the only `alarm_actions` entry (no OK or insufficient-data actions), and the operator must
allow CloudWatch to publish to it. Alarms on the cron DLQ named by `cronDlqArn` are not created
because that queue is not owned by the stack.

The default TypeScript contract test checks descriptor types and referenced paths against the
committed `output-shapes.json` snapshot. `pnpm infra:validate` runs mock-provider Terraform tests
at both pinned provider versions, captures actual output values and compares their normalized
shapes with that snapshot. Output descriptions are informational and are not trusted as type
proof. The opt-in `pnpm infra:mutate` checks the contract against the reviewed fault catalog.
