# Issue-keyed record stage: design and turn plan

Status: implemented through turn 6; real AWS verification remains in M3h. Current behavior and shapes remain in the code and
[INFRA_MODEL.md](./INFRA_MODEL.md). The owner selected grouped writes to address hot-issue
contention and chose **no TTL** on pending bundle items or manifest chunks. Bundle cleanup cron
is required, and operators must alert on its failures, oldest pending bundle and backlog.

## AWS limits and assumptions

- Standard FIFO throughput is 300 requests/s per API action, or up to 3,000 messages/s per
  action with ten-message batches. High-throughput FIFO uses group-scoped deduplication and
  per-group throughput; SQS partitions are managed by AWS and hash each group ID. A partition
  has up to 300 requests/s per action or 3,000 messages/s with batching; aggregate regional
  quotas differ. **One hot issue is one group on one partition**, so more partitions do not
  divide it. These are SQS service limits, not a promised end-to-end record rate.
  [AWS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html),
  [high-throughput partitions](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/high-throughput-fifo.html),
  [required high-throughput settings](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/enable-high-throughput-fifo.html).
- The current design chooses the normal Lambda FIFO event source mapping, with at most 10 records
  per invocation and no batching window. The [Lambda parameter page](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-parameters.html)
  states those limits, while the newer [Lambda SQS guide](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
  describes provisioned pollers allowing larger total batches and a window, with at most 10 per
  group. Treat that newer option as unconfirmed for this project; it is out of scope until tested.
  The same invocation can contain multiple groups. Lambda ordinarily serializes a group, but
  [SQS visibility expiry](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html)
  can cause a duplicate consumer to overlap, so this is not a fencing guarantee.
- SQS messages and the total payload of one SendMessageBatch are each at most 1 MiB; the send
  batch has at most 10 entries. Lambda's synchronous event payload limit and metadata can further
  reduce the delivered count. Store item/transaction limits also apply. FIFO does not support
  per-message send delay: use group-safe visibility changes for retries.
  [SQS quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html),
  [SendMessageBatch](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessageBatch.html),
  [FIFO migration notes](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/FIFO-queues-moving.html).
- `MessageGroupId = issueId`; `MessageDeduplicationId = eventId`; set message-group deduplication
  scope and disable content-based deduplication. The five-minute send-deduplication window does
  not prevent later duplicates or make datastore writes exactly-once. Different projects have
  different deterministic issue IDs. Acceptance order is the only portable ordering; concurrent
  independent producers cannot establish a prior global send order. SQS batch calls can partially
  succeed: retry only failed entries and never claim producer-order preservation across an accepted
  later entry. [AWS FIFO identifiers](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fifo-queue-message-identifiers.html).
- For a failed FIFO invocation, acknowledge only successfully processed earlier records; report
  the failed and all later unprocessed records, even when they belong to another group, in
  `batchItemFailures`. A poison group is blocked until the failing record succeeds or is moved
  to a FIFO DLQ. Redrive later may break the original processing order.
  [Lambda FIFO failure handling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html),
  [SQS DLQ behavior](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/troubleshooting-dlq-redrive.html).

## Throughput and cost model

Assume one normalized event per record message, no retries, 30 days, and initially ignore empty
polls, failed requests, payload-size billing, Lambda duration, blob claim checks, network and DLQ
traffic. SQS API batch efficiency depends on actual grouping, API behavior and payload bytes;
`SendMessageBatch` may need multiple calls. Send, receive and delete are counted separately.
Let `E` be average events per ingest envelope and `S`, `R`, `D` be mean messages per send,
receive and delete request. The common ingest hop costs about `(1/S + 1/R + 1/D) / E` API
calls per event in either mode; the FIFO hop adds the same expression with `E = 1`.

| Quantity | Direct mode | Grouped mode |
| --- | --- | --- |
| Queue hops | Existing standard ingest hop; one envelope may contain several events. | Same ingest hop, plus one FIFO message per event. |
| Incremental FIFO API calls | Zero. | Between 0.3 and 3 calls/event for send + receive + delete, assuming full batches of 10 down to singletons. Empty polls, retries and failed partial sends add calls; SQS bills payload in size chunks. |
| DynamoDB transactions | One per new event, before conflicts/retries. | One per nonempty same-issue group, i.e. `1 / B` per new event for effective group size `B` between 1 and 10, before conflicts/retries. |
| Latency | Existing ingest-queue wait plus one-event commit. | Adds FIFO publish, queue wait and another function invocation; no fixed latency is promised. Standard FIFO mappings do not wait for a configured batching window, so low traffic can have `B = 1`. |

At 1 million events/day across 50 projects, the average is 11.57 events/s overall, 0.231/s per
project if uniform. Direct writes about 1 million transactions/day. Grouped adds 1 million FIFO
messages/day and, for full batches, at least 100,000 send + 100,000 receive + 100,000 delete
calls/day (9 million/month); singletons need up to 3 million/day (90 million/month), excluding
empty polls and retries. For `B = 10`, there are 100,000 record transactions/day, while `B = 1`
leaves one million. Sparse issue traffic may deliver mostly singletons, making the extra queue and
Lambda invocation cost real even when transactional savings are small. Billed request units depend
on payload chunking (each 64 KiB chunk is billed as a request), so these are API-call estimates,
not a price quote. See [SQS pricing](https://aws.amazon.com/sqs/pricing/). The existing DynamoDB
example estimates about 12 WRU/event direct versus 6.6 WRU/event at full same-issue batches,
under its explicit item-size and index assumptions; only the issue update and its index changes
are amortized. Storage, GSI writes, duplicate reads and real AWS consumption still need measurement.

For a single-issue 500 events/s storm, one group cannot be scaled across record invocations while
its lease is valid. If full batches contain 10 events and average round-trip completion time per
batch is `T` seconds, service rate is `min(10 / T, queue/other limits)` events/s. For an **illustrative,
unmeasured** `T = 0.1 s`, that is 100/s: backlog grows 400/s, reaches 24,000 after a 60-second
storm, and takes another 240 seconds to drain after arrivals stop. At `T = 0.5 s`, it is 20/s,
backlog grows 480/s, and the 28,800 messages accumulated in 60 seconds need 1,440 seconds to
drain. Latency rises with backlog, and SQS retention/DLQ alarms must be sized accordingly. If
producer sends are unbatched, the default 300 send requests/s per action/partition can throttle a
500/s hot group before the consumer; high-throughput mode does not split a single group. Full
batches and 0.1/0.5-second completion are assumptions, not measured capacity. The queue absorbs
bursts only if long-run service capacity exceeds arrivals and retention is sufficient.

## Implementation turns

1. **Design (this turn):** owner decisions, port sketches, queue ordering/poison semantics,
   requirements, cost model, AWS references and the plan. No runtime or infrastructure code.
2. **Core ports and in-memory contracts:** add grouped per-physical-queue capabilities, message
   group keys and `recordEvents`; enforce the 1..10 homogeneous group and per-result semantics.
   Extend shared queue and active-store contracts, memory queue/fake, duplicate, malformed, lease
   expiry, mixed-group and atomicity tests. Until each store is migrated, it may omit both `recordEvents` and its capability, which is
   interpreted as unsupported and rejected for grouped stacks;
   run the unmodified applicable contract cases for every capable store, with no weakened cases.
   Keep current consumers direct. Gate after the turn.
3. **Store implementations:** implement one atomic group transaction in SQLite and Postgres
   (defined lock order and retry rules) and the DynamoDB conditional transaction described in
   DYNAMODB_DESIGN.md; retain `recordEvent`. Run shared contracts on both SQL dialects and both
   emulator paths, with injected duplicate races, conflict/ambiguous commit and no partial commit.
4. **SQS FIFO and infra:** implement grouped FIFO producer/push handling and per-queue capabilities;
   add FIFO/DLQ resources and scoped policies, Lambda mappings, manifest/descriptor wiring,
   module contracts and mutation entries. Probe Winterbaume and record gaps without weakening HCL.
   Run queue contracts in both modes and Terraform validation/mutations.
5. **Pipeline and record role:** add explicit stack mode and helper defaults, topic/requirement
   derivation, role/artifact construction, bounded normalized messages and claim checks, safe
   envelope handoff, record batch/poison behavior and FIFO failure responses. Test mixed groups,
   visibility expiry, duplicate publishes, DLQ/redrive and permissions; preserve direct behavior.
6. **Integration and measurement:** add shared/per-topic grouped roots, emulated applies where
   supported, full gate and real-provider/mock policy assertions. Remeasure 200 and 500 simultaneous
   same-issue events on DynamoDB Local through the grouped path, reporting attempts/event, failures,
   effective batch sizes, latency and queue backlog. Test mode-switch drain, event duplication and
   payload cleanup. Add M3h checks for a real AWS FIFO/Lambda deployment and measure the stated
   throughput/cost assumptions. M3g staged-envelope recovery cron and its earlier blob race remain
   queued separately, and M5 bundle cleanup cron must be wired and monitored.


## M3h real deployment checklist (in order)

1. Select a disposable sandbox stack, a clean account namespace, budget and cleanup owner;
   confirm artifact size and select the S3 deployment path if direct ZIP upload is too large.
2. Build and generate both shared and per-topic grouped stacks, review the plan and least-privilege
   IAM grants, then apply one variant. Verify the function URLs, role policies, FIFO and DLQ
   settings, event-source mappings, EventBridge schedule, log groups and alarms.
3. Run the bootstrap and migrations twice, including concurrent invocations. Retrieve the DSN and
   token from Secrets Manager without printing them or writing them to Terraform state or output.
4. Run SDK end-to-end tests: grouping and counts, duplicate sends, FIFO same-group serialization,
   interleaved groups, visibility expiry, partial failures, poison-to-DLQ and redrive. Measure
   batch sizes, transactions/event, drain latency and backlog under 200/500-event hot-issue load
   plus background traffic; compare throughput and request costs with the estimates above.
5. Exercise the recovery schedule with an old staged envelope, concurrent consumer deletion and
   a failed publish; check eventual one-event persistence, retry and logs. Test mode-switch drain
   without overlapping writers, and verify claim-check retention and manual cleanup assumptions.
6. Test RDS/Aurora IAM access from Lambda, verified CA bundle, token refresh after 15 minutes,
   RDS Proxy behavior, and VPC NAT or endpoints for SQS, S3, DynamoDB and Secrets Manager.
7. Verify IAM denial boundaries, TLS-only bucket enforcement, deletion protection, lifecycle
   behavior, CORS and operational alarms with real AWS; exercise provider retries and timeouts.
8. Destroy the disposable stack and inspect AWS APIs for leftover resources and retained data.
   Repeat relevant checks for the other queue topology before considering M3h complete.


The consumer rate path groups candidates by project, issue and received-at fixed window
across a delivery batch before forwarding, then charges one KV increment for each group. The
new-issue cap is checked after a consistent issue read in direct mode and in the grouped record
handler. Admission counters are approximate on retries and concurrent issue creation. KV
retry failures retry the affected batch before any event is recorded or forwarded; accepted
per-delivery handoffs still retry independently on downstream failures. KV bindings and grants
are scoped to the roles running the enabled checks.
