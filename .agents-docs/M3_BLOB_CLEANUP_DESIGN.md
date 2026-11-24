# M3 blob cleanup: what was chosen and built

Status: implemented (item 3 of the M3 queue, owner decisions of 2026-11-24). The earlier
investigation proposed a stricter cron design (operator-configured redrive horizon, durable
deletion intents, conditional event deletion, immutable per-insertion payload keys). The owner did
not choose it; this document records what was built instead and the risks it accepts.

## Grouped-record claim checks (`payloads/records/...`)

- No cron. The `blob-s3` module has an S3 lifecycle rule `expired-record-claims` on the prefix,
  with `record_claim_retention_days` (stack config `recordClaimRetentionDays`), default 30.
  The value is validated at least 15 in both the config schema and the HCL variable, because SQS
  retains messages for at most 14 days.
- Keys are unique per publication (creation timestamp plus a fresh UUID), so an expiry by age never
  races a republish onto the same key. Legacy digest-keyed claims, if any survive, expire by the
  same rule; their possible reuse by an old in-flight producer is bounded by the 14-day queue
  retention that the 15-day minimum already exceeds.
- `RecordHandler` treats a missing claim blob as poison (`MissingClaim`), not as a transient
  error. The delivery is logged on every attempt (`Record claim blob is missing`) and returned as
  `retry`; the queue moves it to the DLQ at `maxReceiveCount` (the record queue always has a DLQ).
  The port has no immediate dead-letter action, so this is the DLQ route. A message redriven from
  the DLQ after the claim expired therefore returns to the DLQ. Operators must redrive within the
  claim retention or re-ingest the data.
- Standalone / filesystem: no sweep. Standalone uses `queue-memory`, which has no redrive horizon
  (undelivered messages are lost on restart; staged-envelope recovery re-queues from raw
  envelopes, not from claims), and `blob-fs` has no modification times or lifecycle. Claim checks
  only exist for records above the queue's maximum message size in grouped mode, a local-development
  option; the leak is bounded by dev data volume. A sweeper without modification times would have
  to guess ages, which is the race the owner declined to take on. Left open if standalone grows a
  durable queue.

## Overflow event payloads (`payloads/<project>/<event>[/<digest>]`)

- `deleteExpiredEvents` (`packages/core/src/retention.ts`) is the retention path: scan events older
  than the project's retention, `deleteBatch` them, then delete their overflow blobs best effort.
  The order is event first, blob second, never reversed. A crash or blob failure leaves an
  orphan blob (logged, counted in `blobFailures`), never a live event without payload. It only
  deletes keys under `payloads/<its own project>/`, never claim checks. DynamoDB TTL deletions
  and any other event removal that bypasses it also leave orphans, which the lifecycle rule
  covers.
- The `retention` cron job is still a placeholder that is scheduled only when archive is selected;
  wiring it (and only deleting archived events then) stays `TODO(M4)`, as do the archive and
  subject-erasure blob hooks.
- Lifecycle rules `orphaned-overflow-payloads-0` to `-9` expire `payloads/<digit>` after
  `max_event_retention_days + overflow_orphan_margin_days` (config `maxEventRetentionDays` default 30,
  `overflowOrphanMarginDays` default 7, so 37 days). One rule per leading digit is needed because
  project IDs are decimal digits and an S3 prefix filter cannot exclude `payloads/records/`
  (an overlapping `payloads/` rule shorter than the claim age would expire claim checks early).
- Safety against deleting a live event's blob: the blob is written when the consumer processes
  the event, after `receivedAt`, so its age is below the event's age; the rule fires only
  `margin` days after the longest retention. The maximum is enforced at project creation: the only
  creation path in a deployed stack is `bootstrapProject`, which now takes `maxRetentionDays` and
  rejects a new or existing project above it; `bootstrapAwsStack` passes the `blob-s3`
  `maxEventRetentionDays` (default 30) and creates the project with `min(30, max)`. There is no
  API to change a project's retention yet; a future one must validate against the same stack value.
- Versioning: the bucket has versioning disabled (a deliberate erasure decision), so expiration
  deletes the only copy and no noncurrent-version rule is added. If versioning is ever enabled,
  `noncurrent_version_expiration` must be added for both prefixes.

## Accepted risks and non-goals

- Overflow keys can be reused for the same project and event ID. If an event is re-ingested after
  retention deleted its row but before the old blob was deleted, a late blob delete can remove the
  new row's payload. The earlier investigation's intent log would close this; it is deliberately
  not built.
- Orphans wait up to retention plus margin for removal.
- Real-AWS lifecycle behaviour is part of the M3h verification, not proven by the emulator.
