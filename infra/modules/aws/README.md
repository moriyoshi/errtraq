# AWS module contracts

These modules are declarative infrastructure, not implemented AWS runtime adapters. The
Lambda artifacts are ZIP files containing `index.handler`; M2c must produce those paths.
Function URLs use `NONE` authorization so unmodified Sentry clients can reach ingest and API.
They are publicly invokable, and errtraq's project key and API token checks must authenticate
requests. The role for each physical function receives only its derived policy documents,
scoped Secrets Manager reads, and permissions to write its own pre-created log group. Secret
identifiers must be Secrets Manager ARNs. A customer-managed secret encryption key also needs
its own KMS key policy or grant. URLs are empty strings when a role is not exposed.
EventBridge uses UTC schedules; the current module accepts five-field Unix schedules with a
wildcard day of week, the form used by core's jobs. The target event is `{ "job": name }`;
the M2c entrypoint must dispatch it to the cron handler. Lambda SQS mappings request partial
batch failure responses, which the M3 queue handler must produce.

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
backup retention in any hard-erasure procedure.

SQS physical queues are keyed maps, each with independent visibility and DLQ settings. The
DLQ retains messages for 14 days. S3 blocks public access, uses SSE-S3, and leaves versioning
disabled so ordinary object deletion does not retain old object versions. Primary permissions
cover the current `envelopes/`, `payloads/`, and reserved `artifacts/` namespaces; staging
permissions cover only the configured staging prefix. New primary namespaces require policy
updates. Abandoned envelopes expire after 14 days by default and archive staging after seven;
operators must choose retention periods longer than their recovery windows. Neither lifecycle
rule applies to durable overflow payloads. S3 bucket deletion is deliberately not forced.
