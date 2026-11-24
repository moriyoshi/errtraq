# M3h third real AWS run: plan

Status: proposed (2026-11-25), awaiting owner approval. Owner decisions so far: include RDS, and let
the operator bring an existing VPC instead of the test network the run would create.

The run closes the real-AWS items left open in TODO.md after the second run (JOURNAL 2026-11-24).
Account, profile, region, VPC and resource identifiers stay out of the repository, as before: the
run's stack files, environment and logs live in `.agents-workspace/tmp/m3h3/` (git-ignored).

## What gets built before the run (no AWS access needed)

1. **Test database fixture** `infra/fixtures/aws/rds-postgres/` (a test fixture, not a product
   module: the Postgres store keeps taking an existing database). It creates:
   - RDS for PostgreSQL, single-AZ `db.t4g.micro`, IAM authentication on, TLS required
     (`rds.force_ssl`), master password managed by RDS in Secrets Manager, no deletion protection,
     no final snapshot;
   - an RDS Proxy with IAM authentication and TLS required, for the proxy-path checks;
   - security groups: database and proxy accept 5432 only from the Lambda security group.
   Network inputs, either:
   - **created** (default): a VPC with two private subnets in two AZs, no NAT, gateway endpoints
     for S3 and DynamoDB, interface endpoints for SQS and Secrets Manager; or
   - **bring your own**: `vpc_id`, `subnet_ids` (at least two AZs) and optionally
     `lambda_security_group_id`; nothing network-level is created, and reachability to SQS, S3,
     DynamoDB and Secrets Manager is the operator's (NAT or endpoints) and is checked by the run.
   Outputs: host, proxy host, `db-` / `prx-` resource IDs, subnet and security group IDs, the
   master secret ARN. `terraform validate` plus a `tftest` with mocked providers covers both
   network modes, so the default gate stays offline.
2. **Run stacks** (in the ignored workspace): `aws-postgres` (Lambda in VPC, Postgres IAM store,
   SQS, S3, DynamoDB KV) and `aws-dynamodb` (grouped, per-topic) for the non-RDS checks.
3. **Probe scripts** extending the second run's `remote-e2e.mjs` / `probe.mjs` for each check below,
   each printing PASS / FAIL with measured values and never printing secrets.

## Checks

### A. RDS and VPC (the `aws-postgres` stack)

| Check | Method | Pass |
| --- | --- | --- |
| IAM token auth from Lambda | e2e through the deployed stack | events stored; no password anywhere |
| Lambda CA bundle and hostname verification | default `/var/runtime/ca-cert.pem`; then connect via an IP / wrong host name | first succeeds, second fails TLS verification |
| New connections after 15 minutes | keep a function warm over 20 min, force new pool connections | no auth failure from token expiry |
| RDS Proxy IAM and TLS | switch `host` / `resourceId` to the proxy, redeploy | e2e passes; `rds-db:connect` scoped to the `prx-` ID |
| Policy scope | second DB user without a grant; foreign resource ID | both refused |
| VPC attachment and ENI permissions | apply, inspect function `VpcConfig`, invoke | ENIs created; no permission errors |
| Service reachability | created network (endpoints) and, if supplied, the operator's VPC | SQS, S3, DynamoDB, Secrets Manager reachable from each role |
| Deployed bootstrap against RDS | `errtraq bootstrap` with migrations; interrupt the first run and rerun | idempotent recovery, bootstrap secret written |
| Visibility expiry race | hold a row lock on the issue from an operator session so the record handler outlives the visibility timeout | event counted once after redelivery |

### B. Queues, store and limits (the `aws-dynamodb` stack)

| Check | Method | Pass |
| --- | --- | --- |
| Mode-switch drain | backlog with the trigger disabled, switch `recordMode` direct → grouped (and back), apply | every event recorded once; old queue drained before removal |
| 500 concurrent same-issue writes | both record modes; count-sort key updates; conditional atomicity | exact counts; retries bounded; measured WCU and conflict rate |
| Provider retries under throttling | the hot rate-limit KV key and the contention run push DynamoDB into throttling | retried, no lost events; error codes recorded |
| SQS edge cases | U+FFFE / U+FFFF bodies, 1 MiB message, throttling codes, receive-count increments | matches the adapter's assumptions |
| FIFO high-throughput readback | apply high-throughput FIFO settings, replan | empty plan |
| S3 edge cases | unsigned payload, spaces and `+` in listed keys, 403 versus missing under the scoped read policy, multipart-abort permission | matches the adapter's assumptions |
| Exact rate counting and project overrides (new since run 2) | redelivery after a forced failure; a project with a tighter limit in grouped mode | no double charge; tighter limit applied |
| Event fixtures | capture SQS, function URL and EventBridge events, scrub, commit as test fixtures | fixtures contain no account data |
| Lifecycle expiry | objects under each expiring prefix with a 1-day rule | gone within 48 hours |

## Order, duration and teardown

1. Plan and apply the fixture (created network) and the `aws-postgres` stack; run A. About 3 hours.
2. If you supply a VPC: destroy the stack, apply the fixture in bring-your-own mode, rerun the
   reachability, bootstrap and e2e rows of A. About 1 hour.
3. Destroy A. Apply `aws-dynamodb`; run B. About 3 hours.
4. Destroy everything except one bucket holding the lifecycle probe objects; check expiry after
   48 hours, then destroy it.

Every apply shows you the plan first. Teardown is checked by listing tagged resources afterwards.

## Cost estimate (us-east-1-class pricing)

RDS `db.t4g.micro` about $0.02/h, RDS Proxy (2-vCPU minimum) about $0.03/h, two interface endpoints
in two AZs about $0.04/h, plus Lambda, SQS, DynamoDB on-demand and S3 requests. Under $5 for the
whole run including the 500-writer contention tests; the lifecycle bucket costs cents.

## Open questions for the owner

1. **Operator access to a private database.** `errtraq bootstrap` (migrations, IAM user creation)
   connects directly, but the database sits in private subnets. Options: (a) for this run, make the
   instance publicly reachable with its security group limited to your IP, TLS and IAM required;
   (b) SSM port forwarding through a small EC2 instance in the VPC; (c) run bootstrap from a
   one-off Lambda inside the VPC, which is also a product feature for private databases. This is
   a real product gap; (c) is the one users would need.
2. **Bring-your-own VPC in this run.** Will you supply a VPC (subnets in two AZs, egress via NAT or
   endpoints) for step 2, or should the run test only the created network and keep the
   bring-your-own path covered by `terraform validate` and tests?
3. **Lifecycle wait.** Is keeping one bucket for 48 hours after the run acceptable?
