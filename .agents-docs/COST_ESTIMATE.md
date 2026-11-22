# Running-cost estimate: AWS, GCP, Cloudflare

Estimate as of 2026-11-23. Only the AWS stack exists today; the GCP and Cloudflare figures assume the
adapters planned in ARCHITECTURE.md (M6, M7) and are design estimates. List prices, US regions
(us-east-1, us-central1), on-demand, before tax, support plans and committed-use discounts. Check
the linked pricing pages before budgeting.

## Workload

| Scenario | Events / month | Notes |
| --- | --- | --- |
| Small | 300 k (10 k / day) | A few projects. |
| Example | 30 M (1 M / day) | The design docs' reference: 50 projects, ~11.6 events/s. |
| Large | 300 M (10 M / day) | |

Assumptions for every platform:
- One event per envelope.
- Events are 2 KiB.
- The active store keeps 30 days of events.
- The ingest rate limit is on (one counter increment per envelope).
- Per-issue rate rejection is off.
- The archive tier (M4) is excluded; it adds well under $1 per month per month of history on object
  storage.

## Results

| Scenario | AWS (DynamoDB) | GCP (Firestore) | Cloudflare (D1) |
| --- | --- | --- | --- |
| Small | ~$7 | ~$3 | $5 (plan minimum) |
| Example | ~$590 | ~$395 | ~$630 |
| Large | ~$5,800 | ~$3,900 | ~$6,200 |
| Example without envelope staging (see below) | ~$425 | ~$235 | ~$490 |

Large is roughly 10x Example, because nearly every cost is per request.

## AWS, Example scale (DynamoDB stack, grouped record mode)

| Component | Basis | $/month |
| --- | --- | --- |
| Lambda (x86, 512 MB) | 30 M ingest invocations at ~50 ms; consumer and record ~15 M invocations each at ~100 ms (about 2 events per batch); $0.20/M requests, $0.0000166667/GB-s | ~50 |
| SQS | Standard ingest queue: 30 M send + 15 M receive + 15 M delete at $0.40/M. FIFO record queue: ~45 M requests at $0.50/M. Plus idle polling | ~49 |
| DynamoDB writes | ~9 WRU/event in grouped mode at 2 events per issue batch (12 in direct mode); 270 M WRU at $0.625/M | ~169 |
| DynamoDB retention deletes | 4 WRU/event (item + 2 index entries); 120 M WRU | ~75 |
| DynamoDB reads | ~2 strongly consistent RRU/event; $0.125/M | ~8 |
| DynamoDB ingest rate counter | 1 read + 1 conditional write per envelope | ~23 |
| DynamoDB storage + PITR | ~77 GB at $0.25 + $0.20 per GB-month | ~35 |
| S3 envelope staging | 1 PUT ($0.005/1 k) + 1 GET ($0.0004/1 k) per envelope | ~162 |
| CloudWatch | ~24 GB of Lambda logs at $0.50/GB; ~12 alarms at $0.10 | ~15 |
| Secrets Manager, EventBridge schedule, function URLs, inbound transfer | One secret; schedules and URLs are free | <1 |
| **Total** | **~$19.6 per million events** | **~590** |

Small scale fits Lambda's and SQS's always-free allowances. What remains is ~$3 of DynamoDB, ~$1.50 of
S3 PUTs, and alarms plus the secret.

**Measured on the real deployment (2026-11-22, 771 events, hot issue):**
- 190 DynamoDB transactions in all, about 4 events per issue batch.
- 2,328 write units on the base table, about 3 per event. The index writes are billed separately and
  were not captured, so this neither confirms nor contradicts the ~9 per event above.

The per-event write figure needs a measurement at realistic, non-hot traffic, where batches are
smaller.

**Postgres instead of DynamoDB:**
- An RDS db.t4g.medium (Single-AZ, ~$47) plus 100 GB of gp3 storage (~$12) replaces about $310 of
  DynamoDB.
- Lambda then runs in a VPC. It needs a NAT gateway (~$33 plus $0.045/GB) or interface endpoints
  (~$7.30 per endpoint per AZ) to reach SQS and Secrets Manager. The S3 and DynamoDB endpoints are
  free gateway endpoints.
- Expect ~$100-150 for the store and network, so ~$350-450 in total. Multi-AZ roughly doubles the
  database cost.

## GCP, Example scale (planned: Cloud Run, Firestore Standard, Pub/Sub, GCS)

| Component | Basis | $/month |
| --- | --- | --- |
| Cloud Run | ~90 M requests (ingest plus two push hops; Pub/Sub push delivers one message per request) at $0.40/M after the 2 M free; about one 1-vCPU / 512 MiB instance active most of the time at $0.000024 per vCPU-s | ~95-135 |
| Pub/Sub | Two topics; publish and delivery at a 1 KB minimum per message, ~0.12-0.23 TiB at $40/TiB after 10 GiB free | ~5-9 |
| Firestore writes | Event document + issue update, ~1.5 writes/event with issue batching; 45 M at $0.90/M | ~41 |
| Firestore rate counter | 1 read + 1 write per envelope | ~36 |
| Firestore reads and deletes | ~2 reads/event at $0.30/M; 30 M deletes at $0.10/M | ~21 |
| Firestore storage | ~90 GiB including index entries at $0.15 | ~14 |
| GCS envelope staging | 1 class A ($0.005/1 k) + 1 class B ($0.0004/1 k) operation per envelope | ~162 |
| Logging, Scheduler, Secret Manager | Mostly inside the free allowances | <5 |
| **Total** | **~$13 per million events** | **~395** |

GCP comes out cheapest mainly because Firestore bills per document, not per index entry or KiB.

**Design constraint:** Firestore sustains about 1 write per second per document. Three things follow:
- The issue document needs the issue-keyed batching, using Pub/Sub ordering keys.
- A hot DSN key's ingest rate counter needs sharded counters, or Memorystore (from ~$35/month).
- These are not optional the way they are on DynamoDB.

## Cloudflare, Example scale (planned: Workers Paid, Queues, D1, R2, Durable Objects)

| Component | Basis | $/month |
| --- | --- | --- |
| Workers Paid plan | Includes 10 M requests and 30 M CPU-ms | 5 |
| Workers usage | ~31 M requests (consumer batches up to 100) at $0.30/M; ~180 M CPU-ms at $0.02/M | ~9 |
| Queues | 3 operations per message: (30 M x 3 - 1 M) at $0.40/M | ~36 |
| D1 rows written | Event insert + ~4 index rows, issue update + ~3 index rows: ~9 rows/event, plus ~5 rows per retention delete. 420 M - 50 M included, at $1/M | ~370 |
| D1 storage | ~70 GB - 5 GB included, at $0.75/GB-month | ~49 |
| R2 envelope staging | Class A $4.50/M + class B $0.36/M per envelope, after the free allowance | ~138 |
| Rate counters on Durable Objects | ~30 M requests at $0.15/M, plus duration and storage | ~5-25 |
| Workers Logs | ~30 M lines - 20 M included, at $0.60/M | ~6 |
| **Total** | **~$21 per million events** | **~630** |

Small scale fits entirely in the $5 plan: ~0.9 M queue operations, ~4 M D1 rows and 0.3 M R2 writes
are all inside its allowances. Cloudflare is the cheapest option for small deployments.

**Design constraints:**
- **D1 database size:** each database is capped at 10 GB, so events must be sharded across databases
  (per project, for example).
- **D1 write cost:** rows written dominate the bill, and every index adds a row, so keep D1 indexes
  minimal.
- **Rate counters:** Workers KV is unsuitable for counters. It accepts one write per second per key, is
  eventually consistent, and costs $5 per million writes. Counters need a Durable Objects adapter.
- **Grouped mode:** Cloudflare Queues has no per-key ordering, so grouped mode is unavailable and the
  stack runs in direct mode.

## Biggest lever: envelope staging

Ingest stores every envelope in the object store before queueing a small reference (claim check), and
the consumer reads and deletes it. At Example scale that is ~$140-160 per month on every platform, and
25-40% of the bill, almost all of it PUT requests.

Putting envelopes below a threshold directly in the queue message would remove it. The limits are:
- SQS: 1 MiB;
- Pub/Sub: 10 MB;
- Cloudflare Queues: 128 KB.

The claim check would remain above the threshold. ARCHITECTURE.md currently makes the claim check
unconditional, so changing it is an architecture decision.

## Other levers

- **Compress event payloads:** DynamoDB bills writes per started KiB, so a 2 KiB event compressed below
  1 KiB halves its write units.
- **Run Lambda on arm64:** about 20% less Lambda compute.
- **Direct vs grouped mode on AWS when no issue is hot:** direct drops the FIFO queue and the record
  function (about -$38) but writes ~12 instead of ~9 WRU per event (about +$56), so it's roughly a
  wash.
- **Retention:** each day of active retention costs storage, and every event is eventually deleted
  (~$75/month of DynamoDB deletes). The archive tier will move old events to cheaper storage rather than
  delete them.

## Sources

- [AWS Lambda](https://aws.amazon.com/lambda/pricing/)
- [Amazon SQS](https://aws.amazon.com/sqs/pricing/)
- [DynamoDB](https://aws.amazon.com/dynamodb/pricing/)
- [Amazon S3](https://aws.amazon.com/s3/pricing/)
- [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/)
- [Amazon RDS](https://aws.amazon.com/rds/postgresql/pricing/)
- [Cloud Run](https://cloud.google.com/run/pricing)
- [Firestore](https://cloud.google.com/firestore/pricing)
- [Pub/Sub](https://cloud.google.com/pubsub/pricing)
- [Cloud Storage](https://cloud.google.com/storage/pricing)
- [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
- [D1](https://developers.cloudflare.com/d1/platform/pricing/)
- [Queues](https://developers.cloudflare.com/queues/platform/pricing/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/)

The Cloudflare D1 / Queues / KV, Firestore and Cloud Run rates were re-checked on 2026-11-23. The rest
are list prices as known in mid-2026.
