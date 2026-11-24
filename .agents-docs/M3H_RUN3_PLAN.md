# M3h third real AWS run: plan

Status: decisions taken (2026-11-25); the pre-run build awaits a go-ahead. Owner decisions: include
RDS; the fixture lets the operator choose between a created network and an existing VPC at run time;
operator access to a private database is a product feature (a bootstrap Lambda, below); the 48-hour
lifecycle expiry check is skipped (run 2's accepted-rules check stands).

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

## Order, duration and teardown

1. Plan and apply the fixture (created network) and the `aws-postgres` stack; run A. About 3 hours.
2. Bring-your-own network, if chosen at run time: destroy the stack, apply the fixture with your
   VPC and subnets, rerun the reachability, bootstrap and e2e rows of A. About 1 hour.
3. Destroy A. Apply `aws-dynamodb`; run B. About 3 hours.
4. Destroy everything.

Every apply shows you the plan first. Teardown is checked by listing tagged resources afterwards.

## Cost estimate (us-east-1-class pricing)

RDS `db.t4g.micro` about $0.02/h, RDS Proxy (2-vCPU minimum) about $0.03/h, two interface endpoints
in two AZs about $0.04/h, plus Lambda, SQS, DynamoDB on-demand and S3 requests. Under $5 for the
whole run including the 500-writer contention tests.

## Bootstrap Lambda (product feature, built before the run)

A private database cannot be reached from the operator's machine, so `errtraq bootstrap` gains a
deployed mode that runs inside the stack's network. Sketch, to be confirmed in ARCHITECTURE.md when
implemented:

- A new optional function role `bootstrap`: no HTTP URL, no queue trigger, no schedule; invoked
  only by the operator (`lambda:InvokeFunction` on the operator's own credentials). It shares the
  platform's VPC placement and receives the store's read, write and migration access.
- `errtraq bootstrap --remote` (name to settle) builds the same options as today and invokes the
  function synchronously. The payload carries only non-secret options (org and project slugs,
  retention, rate limits); the response carries only a non-secret summary.
- The function runs migrations and the existing bootstrap, writes the DSN and API token to the
  bootstrap secret itself (it gets `secretsmanager:PutSecretValue` on that one secret), and is
  idempotent and resumable like the local path.
- Postgres IAM needs a database user with `rds_iam` before IAM logins work. The Postgres selection
  gets an optional administrative secret (`adminSecret`) used only by the bootstrap role to create
  that user and grant schema privileges; runtime roles never receive it.
- Platforms without a deployable bootstrap role keep the direct path.

## Open questions for the owner

None beyond the go-ahead for the pre-run build (fixture, bootstrap Lambda, run stacks and probes).
The run itself starts only after a separate go-ahead, with each plan shown before apply.
