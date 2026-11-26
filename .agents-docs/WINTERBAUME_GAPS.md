# Winterbaume gaps found by Terraform provider probes

The historical provider probe below targeted revision `69fed1d7fb0eb9a2738ff3274197c7591129c4cb`.
The pinned emulator is the prebuilt release `winterbaume-server-v0.2.10` (commit
`f79b3353ec2e49259267572719a15b4a29955435`; on hosts without a pinned prebuilt asset the installer
builds the checksum-pinned `source.tar.gz`). Earlier pins fixed the S3 lifecycle header, DynamoDB SSE
and deletion protection, EventBridge retry/DLQ fields and the Lambda partial-batch setting. v0.2.9 also fixes
S3 ownership-control deletion, tag readback for DynamoDB, IAM, S3 and Lambda event source mappings, S3
UTF-8 keys, Lambda permission conditions, the Lambda mapping function filter and `ScalingConfig`;
their exceptions are removed. The remaining sections describe the historical observations unless
stated otherwise; see "Status at v0.2.10" for the current state (the status table at v0.2.9 below it is kept as history). `pnpm infra:probe-emulated` creates an isolated local server,
uses the real AWS provider with loopback-only endpoints and no AWS credentials, and saves
Terraform apply and provider debug logs in an ignored scratch directory. Runs are capped
at 90 seconds per apply; a timeout is a probe limit, not an AWS error response. The probe
is an inventory: it does not implement the complete M3a2 apply/assert/destroy workflow.
The existing `pnpm infra:validate` mock-provider checks remain in place.

## Status at v0.2.10

Re-tested against the v0.2.10 binary (release published 2026-11-26, tag commit
`f79b3353ec2e49259267572719a15b4a29955435`; 21 commits since v0.2.9) on 2026-11-26, loopback only,
no credentials. v0.2.10 fixes #61, #62, #64 to #66, #67, #68 and #69 (upstream commits "atomic DynamoDB
conditional writes, Lambda function settings, EC2 security group descriptions", "FIFO deduplication scope, message
group gating and system attributes", "apply PutRule tags on creation and scope rules by event bus", "accept AWS
JSON 1.0 and keep every PutMetricAlarm setting"). It also adds opt-in STS relaxations (`--relax`, #77, not used by
errtraq) and release-harness fixes. Retested by a direct probe against a fresh server and by the harness
(`pnpm test:aws-emulated`, `pnpm infra:apply-emulated`); the five named exceptions of `gaps.json` are all removed
and the repeat plans of the shared and per-topic stacks are now empty.

| Gap | Status | Evidence |
| --- | --- | --- |
| #48 Lambda Invoke executes ZIP | still reproduces | `Invoke` of a valid ZIP returns `{}` |
| #49 S3 bucket policy enforcement | still reproduces | TLS-deny policy stored; `PutObject` over HTTP returns 200 |
| #61 DynamoDB conditional atomicity | fixed | `assertConditionalUpdateAtomic`: 150 rounds of 200 concurrent `attribute_not_exists` updates, exactly one winner per round (v0.2.9: 19 of 100 rounds had several). The full store repository contract (concurrent writers, CAS, erasure transitions, token creation, concurrent bootstrap; 49 tests) passes against winterbaume three times in a row, so its exclusion list was removed from `run.mjs` |
| #62 Lambda `VpcConfig` | fixed | `CreateFunction` and `GetFunction` return `VpcConfig` (also `Architectures` and `EphemeralStorage`); the Postgres IAM fixture applies the unmodified `lambda-app` module |
| #64 SQS FIFO `DeduplicationScope` / `FifoThroughputLimit` | fixed | readback `messageGroup` / `perMessageGroupId` |
| #65 SQS FIFO group exclusion | fixed | a second receive returns nothing while the group's first message is in flight |
| #66 SQS FIFO receive attributes | fixed | `MessageGroupId`, `MessageDeduplicationId`, `SequenceNumber` returned when requested through `MessageSystemAttributeNames` (the older `AttributeNames` receive still works) |
| #67 EventBridge rule tags | fixed | `PutRule` tags are returned by `ListTagsForResource`; the repeat plan has no `tags_all` drift |
| #68 CloudWatch alarm readback | fixed | query API `PutMetricAlarm` period 300, 3 periods, `DatapointsToAlarm` 2 and `TreatMissingData` read back as set; a new alarm starts in `INSUFFICIENT_DATA` |
| #69 CloudWatch AWS JSON 1.0 | fixed | `GraniteServiceVersion20100801.ListMetrics` returns `{"Metrics":[]}` |
| #81 S3 presigned requests | still reproduces | query-string SigV4 `GET` returns 404 `UnknownService` |
| #82 S3 unsigned requests | still reproduces | an unsigned `GET` returns 404 `UnknownService` |
| S3 Tables, ECR | still absent | no such services (unchanged; see the sections below) |

`pnpm infra:probe-emulated` with `ERRTRAQ_PROBE_PROVIDER=6.73.0` (the default 6.32.1 cannot initialise `lambda-app`, which requires provider >= 6.73.0): `dynamodb`, `sqs`, `s3`, `lambda-app` and `generated-root` apply; `lambda-app` now has a clean second plan (exit 0; at v0.2.9 it drifted) and `generated-root`, which hit the 90 second spawn timeout at v0.2.9, applies within the limit. `Invoke` still returns `{}` (#48). `dynamodb-protected` still fails with `ResourceInUseException` and the `dynamodb` target's API observation still reports its table missing: both come from the probe sharing one emulator and table-name scheme between targets, not from the emulator, and are unchanged from v0.2.9.

Everything marked fixed at v0.2.9 in the older table still holds (run again by the harness). Code consequences:
`gaps.json` is `{}` (a new exception must be declared there and documented under a heading of this file);
`assertRepeatPlan` accepts only empty repeat plans; the SQS and Lambda modules are applied unmodified; the
probes assert FIFO, conditional atomicity and VPC readback instead of requiring them to fail. Still open
for the harness: see TODO.md ("Winterbaume v0.2.10").

## Status at v0.2.9 (history)

Re-tested against the v0.2.9 binary on 2026-11-25 (loopback only, no credentials).

| Gap | Status | Evidence |
| --- | --- | --- |
| #29 S3 ranged GET | fixed (earlier) | `run.mjs` range probe passes |
| #41 S3 lifecycle header | fixed (earlier) | standalone check reads the header back |
| #42 DynamoDB deletion protection | fixed (earlier) | protected table refuses `DeleteTable` |
| #43 DynamoDB SSE | fixed (earlier) | repeat plan keeps the setting |
| #44 Lambda permission conditions | fixed | `GetPolicy` returns `lambda:FunctionUrlAuthType` and `lambda:InvokedViaFunctionUrl` conditions and no extra statements |
| #45 Lambda partial batch and `ScalingConfig` | fixed | mapping readback returns both |
| #46 Lambda mapping list filter | fixed | `FunctionName` filter returned only that function's mapping |
| #47 EventBridge retry/DLQ | fixed (earlier) | `checkEventbridgeGap` asserts readback |
| #48 Lambda Invoke executes ZIP | still reproduces | `Invoke` of a valid ZIP returns `{}` |
| #49 S3 bucket policy enforcement | still reproduces | TLS-deny policy stored; `PutObject` over HTTP returns 200 |
| #50 S3 ownership-control deletion | fixed | `GetBucketOwnershipControls` returns 404 after delete; real module applies and destroys |
| #51 DynamoDB tag readback | fixed | shared-stack repeat plan no longer drifts on `tags_all` |
| #52 IAM role tag readback | fixed | same repeat plan |
| #53 S3 bucket tag readback | fixed | same repeat plan |
| #54 Lambda mapping tag readback | fixed | same repeat plan |
| #58 S3 UTF-8 keys | fixed | `utf8-key-list` probe passes; BlobStore contract passes on the unpatched binary (patch removed) |
| #61 DynamoDB conditional atomicity | still reproduces | `checkConditionalUpdateGap`: 19 of 100 rounds of 200 concurrent `attribute_not_exists` updates had more than one winner |
| #62 Lambda `VpcConfig` | still reproduces | create and `GetFunction` omit it; apply harness check |
| #64 SQS FIFO `DeduplicationScope` / `FifoThroughputLimit` | still reproduces | readback `queue` / `perQueue` after requesting `messageGroup` / `perMessageGroupId` |
| #65 SQS FIFO group exclusion | still reproduces | second receive returned the next message of the same group while the first was in flight |
| #66 SQS FIFO receive attributes | still reproduces | `MessageGroupId`, `MessageDeduplicationId`, `SequenceNumber` absent |
| #67 EventBridge rule tags | still reproduces | repeat plan drift on `tags_all`; `ListTagsForResource` returns none |
| #68 CloudWatch alarm readback | still reproduces | no `DatapointsToAlarm` / `TreatMissingData`; repeat-plan drift; query-API period 300 / 3 periods read back as 60 / 1; new alarm state `OK` |
| #69 CloudWatch AWS JSON 1.0 | still reproduces | JSON 1.0 `ListMetrics` returns `MissingAction` |

## Provider support inventory

The module and generated-root probes below were run with both pinned AWS provider
versions, 6.30.0 and 6.73.0. Where a resource was accepted, readback was checked as
stated; successful creation by itself does not prove all settings were retained.

| Module or resource | Observation |
| --- | --- |
| DynamoDB store table | Module applied; API returned eight GSIs, registered TTL and enabled PITR. Encryption and deletion protection have the gaps below. |
| SQS shared queue and DLQ | Module applied; API returned the configured visibility, retention, maximum message size, managed SSE flag and redrive policy. |
| S3 bucket, access block, encryption, ownership, versioning and TLS policy | Resources applied and representative settings read back; TLS policy enforcement is absent. |
| S3 lifecycle | Apply timed out during propagation readback; see below. |
| IAM roles and inline policies | Created by the Lambda module; an inline capability policy was retrieved through IAM. Enforcement was not tested. |
| Lambda function, URL, permissions and event source mapping | Module applied with a ZIP; settings and execution have the gaps below. |
| CloudWatch log group, EventBridge rule and target | Created by the Lambda module; target retry and dead-letter settings have the gaps below. |
| CloudWatch metric alarms (SQS and Lambda modules) | Applied and read back through the query API; datapoint and missing-data settings have the gap below. |
| Generated AWS stack | Apply reached the S3 lifecycle waiter and exceeded the probe timeout; complete root application remains unproven. |
| STS | GetCallerIdentity succeeded in the M3a direct control-plane probe. |

## S3 lifecycle configuration does not stabilize

Fixed at pinned revision `79c452d2bb2844abf771cfa4a497275c24b46489`: the lifecycle header is retained.

- Resource: `aws_s3_bucket_lifecycle_configuration` in the unchanged S3 module. The
  provider sends `PutBucketLifecycleConfiguration` with header
  `x-amz-transition-default-minimum-object-size: all_storage_classes_128K`. Winterbaume
  responds HTTP 200. Repeated `GetBucketLifecycleConfiguration` returns HTTP 200 and
  the configured rules, but omits that response header.
- Observed error: no AWS error; the provider repeatedly waits for equality and the harness
  terminates the apply after 90 seconds with `spawnSync terraform ETIMEDOUT`. The provider's
  lifecycle equality check compares the requested and returned minimum-object-size values.
  This blocks a complete S3 module apply and can block the generated stack.

## S3 ownership-control deletion is ignored

Fixed at v0.2.9: deletion removes the controls and the module applies and destroys unmodified.

- Resource: `aws_s3_bucket_ownership_controls`. After `PutBucketOwnershipControls`
  sets `BucketOwnerEnforced`, `DeleteBucketOwnershipControls` returns HTTP 204 but
  a subsequent `GetBucketOwnershipControls` still returns HTTP 200 and the same
  controls. The Terraform provider eventually reports `waiting for S3 Bucket Ownership
  Controls (...) delete: found resource`, and ordinary generated-root destroy cannot
  finish. A separate bucket reproduced the request and response sequence.

## DynamoDB server-side encryption cannot be read back

Fixed at pinned revision `79c452d2bb2844abf771cfa4a497275c24b46489`: the repeat plan retains the enabled encryption setting.

- Resource: `aws_dynamodb_table`, `server_side_encryption { enabled = true }`.
  The provider sends `CreateTable` with `SSESpecification: { "Enabled": true }`;
  `DescribeTable` returns no `SSEDescription` field. There is no error. This probe
  cannot establish that the requested encryption setting is honored; the emulator's
  in-memory storage cannot demonstrate encryption at rest.

## DynamoDB deletion protection is ignored

Fixed at pinned revision `79c452d2bb2844abf771cfa4a497275c24b46489`: a protected table refuses deletion.

- Resource: `aws_dynamodb_table`, `deletion_protection_enabled: true`. With
  providers 6.30.0 and 6.73.0, the production-mode module applies successfully, but
  `DescribeTable` reports `DeletionProtectionEnabled: false`. `terraform destroy`
  then succeeds and deletes that table. There is no error. A direct `CreateTable`
  request carrying `DeletionProtectionEnabled: true` reproduced the false readback
  and successful `DeleteTable` independently. Production deletion protection cannot
  be verified against this revision.

## Resource tag readback is incomplete

Fixed at v0.2.9 for DynamoDB, IAM, S3 and Lambda event source mappings (#51-#54). Only the EventBridge rule gap below remains.

- Resource: the generated stack's DynamoDB tables, S3 bucket, IAM roles and Lambda
  event-source mapping. With provider 6.73.0, a repeat plan adds the `app` default tag
  back to each affected resource's `tags_all`, despite successful creation. For example,
  `CreateTable` sends its tags, but `ListTagsOfResource` returns an empty `Tags` array.
  No API error is returned. The emulator cannot establish tag persistence or a truly empty
  unfiltered repeat plan for these resources.

## EventBridge rule tag readback is incomplete

Fixed at v0.2.10 (#67); the text below is historical.

- Revision: `79c452d2bb2844abf771cfa4a497275c24b46489`; provider `6.73.0`.
- Resource: `aws_cloudwatch_event_rule` for `staged-recovery`; `PutRule` creates the rule,
  but its tag readback does not retain the `app=errtraq` default tag. A repeat plan proposes
  `tags_all` changing from `{}` to `{app = "errtraq"}`; no API error is returned. The apply
  harness checks that this exact named gap still occurs and ignores only that drift. EventBridge
  tag persistence remains unproven. Filed as
  [issue #67](https://github.com/moriyoshi/winterbaume/issues/67).

## CloudWatch alarm datapoint and missing-data settings are not returned

Fixed at v0.2.10 (#68 and #69); the text below is historical.

- Revision: `79c452d2bb2844abf771cfa4a497275c24b46489`; provider `6.73.0`; reproduced through
  the real provider by the apply harness (M3 alarms).
- `aws_cloudwatch_metric_alarm` applies without error and the monitoring query
  `DescribeAlarms` returns the name, namespace, metric, dimensions (including a FIFO `.fifo`
  queue name), statistic, period, evaluation periods, threshold, comparison operator and SNS
  alarm action. It never returns `DatapointsToAlarm` or `TreatMissingData`, so a repeat plan
  proposes `datapoints_to_alarm` from `0` and `treat_missing_data` from `"missing"` to the
  configured values. No API error is returned. The harness requires exactly this drift (the
  named exception fails when it stops reproducing) and ignores only those two fields; the
  Terraform mock tests assert both settings, and tracked HCL is unchanged. Tags read back
  correctly, and destroy leaves no alarm.
- Separately, a hand-built query-API `PutMetricAlarm` (period 300, three evaluation periods)
  came back as period 60 and one evaluation period, while the provider's request retained
  both; the provider appears to use a different request protocol than the query API.
  Evaluation, state changes and SNS delivery are unverified. Filed as
  [issue #68](https://github.com/moriyoshi/winterbaume/issues/68); the protocol failure is
  [issue #69](https://github.com/moriyoshi/winterbaume/issues/69).

## DynamoDB conditional updates are not atomic with their checks

Fixed at v0.2.10 (#61): the condition is evaluated inside the backend in the same step as the write. The text below is historical.

- Revision: `69fed1d7fb0eb9a2738ff3274197c7591129c4cb`; v0.2.9 (and `79c452d2bb2844abf771cfa4a497275c24b46489`) still has the separate `get_item` and `update_item` calls. `UpdateItem` reads and
  evaluates `ConditionExpression` in the request handler, then separately calls the backend
  update. Concurrent requests can both pass the same old revision. During the KV contract,
  50 concurrent revision-guarded increments initially returned only 49 distinct results.
  The handler implementation confirms the check and write are separate awaited operations.
  The KV runtime returns the atomic `ADD` result, which lets the contract pass, but this
  emulator cannot prove the atomicity of conditional changes, expiry resets or overflow
  guards under concurrent writes. At v0.2.9 the race still reproduces (19 of 100 rounds of 200 concurrent `attribute_not_exists` updates had more than one winner). The emulator test now reprobes this
race and fails if it cannot reproduce the listed exception. Real DynamoDB verification remains necessary.

## Lambda resource policy conditions are discarded

Fixed at v0.2.9: `GetPolicy` returns the conditions and no extra statements.

- Resource: `aws_lambda_permission` for a public function URL. `AddPermission` accepts
  `FunctionUrlAuthType: NONE` and, for the second permission,
  `InvokedViaFunctionUrl: true`. The HTTP 201 responses and subsequent `GetPolicy` retain
  the actions and principals but omit the corresponding conditions. There is no error.
- Function URL creation also inserted two additional public statements in the observed
  function policy. The mock cannot establish the exact intended URL-only permissions or
  their enforcement.

## Lambda partial batch response setting is discarded

Fixed at pinned revision `79c452d2bb2844abf771cfa4a497275c24b46489`: ReportBatchItemFailures is returned.

- Resource: `aws_lambda_event_source_mapping`. The provider's
  `CreateEventSourceMapping` request includes
  `FunctionResponseTypes: ["ReportBatchItemFailures"]`; the HTTP 202 response and
  `GetEventSourceMapping` omit it. There is no error. A second provider plan proposes an
  in-place update adding `ReportBatchItemFailures` again, so the Lambda module is not
  idempotent against this emulator.
- The observed mapping was also accepted with a queue ARN for a queue that did not exist
  in the standalone module probe. This does not prove AWS event-source validation.

## Lambda mapping list ignores the function filter

Fixed at v0.2.9: the `FunctionName` filter is applied.

- Resource: `aws_lambda_event_source_mapping`. A `ListEventSourceMappings` request
  with `FunctionName` set to one test function returned mappings for that function and
  two other functions. The response was HTTP 200 with no error. Inventory assertions
  must filter returned `FunctionArn` themselves rather than trust this server-side filter.

## EventBridge retry policy is discarded

Fixed at pinned revision `79c452d2bb2844abf771cfa4a497275c24b46489`: retry and DLQ settings are returned.

- Resource: `aws_cloudwatch_event_target`. `PutTargets` sends `RetryPolicy` with
  `MaximumEventAgeInSeconds: 86400` and `MaximumRetryAttempts: 185` and succeeds;
  `ListTargetsByRule` returns the target ARN and job input but omits `RetryPolicy`.
  A provider 6.73.0 module apply with `DeadLetterConfig` configured, and a separate
  direct `PutTargets` request, both succeeded; readback omitted both `RetryPolicy` and
  `DeadLetterConfig`. The direct request returned `FailedEntryCount: 0`. EventBridge
  retry and dead-letter behavior cannot be verified by these observations.

## S3 bucket policy is stored but not enforced

- Resource: `aws_s3_bucket_policy`, TLS-only deny. After `PutBucketPolicy`,
  `GetBucketPolicy` returns the deny on `aws:SecureTransport: false`. An ordinary
  `PutObject` sent over HTTP to the bucket nevertheless returns HTTP 200, with no error.
  The emulator therefore cannot establish transport or IAM policy enforcement.

## Lambda Invoke does not execute the uploaded ZIP

- Resource: `aws_lambda_function`. A valid ZIP contains `index.handler`, returning
  `{ "statusCode": 200, "body": "ok" }`. `Invoke` with `{}` returns HTTP 200 and
  `{}` instead. The pinned server's invocation handler resolves the version and returns
  that fixed response; it does not execute the ZIP. Built errtraq bundles, function URL
  delivery and SQS-triggered execution therefore remain unproven here.

## AWS provider 6.30.0 GSI diff (not an established Winterbaume gap)

- Resource: `aws_dynamodb_table` with GSIs declared using `key_schema`. After a
  successful apply and correct `DescribeTable` key-schema readback, provider 6.30.0
  plans to remove and re-add all eight GSI blocks. Provider 6.73.0 does not. The
  [6.30.0 provider diff code](https://github.com/hashicorp/terraform-provider-aws/blob/v6.30.0/internal/service/dynamodb/table.go)
  special-cases legacy `hash_key` when `key_schema` is used, but not legacy `range_key`;
  [6.73.0](https://github.com/hashicorp/terraform-provider-aws/blob/v6.73.0/internal/service/dynamodb/table.go)
  handles both. The [6.32.1 source](https://github.com/hashicorp/terraform-provider-aws/blob/v6.32.1/internal/service/dynamodb/table.go)
  is the first released version with both cases; 6.32.0 lacks the fix. The declared minimum
  is now 6.32.1. This was a provider issue, not a Winterbaume exception. The emulator API
  readback itself has the intended eight keys and projections.

## S3 percent-decoding corrupts UTF-8 keys

Fixed at v0.2.9; the local patch and its installer were removed and the BlobStore contract runs against the plain binary. The text below is historical.

- Resource: S3 object paths and ListObjectsV2 query parameters at the pinned source
  revision. `PUT` of a key containing the UTF-8 percent-encoded bytes for a non-ASCII
  character succeeds, but a subsequent listing returns each byte as a separate character
  rather than the original key. The S3 handler's `percent_decode` converts each byte to a
  Rust `char` before decoding UTF-8. A byte-ordered cursor can then repeat or skip keys.
- The unmodified emulator probe retains a check for this gap. The BlobStore contract uses
  a separate source build with the checksum-verified `winterbaume-s3-utf8.patch`, which
  decodes the accumulated bytes as UTF-8. This is a local test patch, not an upstream fix;
  the unpatched emulator and Terraform integration remain unchanged. The patch should be
  removed when a pinned upstream revision fixes the decoder. This new gap has not yet
  been filed upstream.

## S3 range requests in server release 0.2.6

- Resource: S3 `GetObject` with `Range: bytes=1-3` on a six-byte object. Server release
  0.2.6 returns HTTP 200 and all six bytes, rather than HTTP 206 and the requested three.
  A separately signed AWS CLI request reproduced this; there is no error response.
  The pinned release passes this probe.

The real-provider integration workflow checks the supported API readbacks and resource
inventories with named, self-verifying exceptions for the gaps above. Its filtered repeat
plan is not a truly empty unfiltered Terraform plan. IAM enforcement, encryption at rest,
function execution, actual encryption at rest, lifecycle execution, IAM enforcement and the
remaining excluded behavior remain unproven until a real AWS deployment or emulator support.

## Upstream issues

Filed against `moriyoshi/winterbaume` at revision `69fed1d7fb0eb9a2738ff3274197c7591129c4cb`,
each with a minimal AWS CLI reproduction. When one is fixed, bump the pinned release in
`scripts/aws-emulated/emulator-binary.mjs` (and the asset checksums used by `install.mjs`) and remove the matching entry from
`scripts/aws-emulated/gaps.json` (`pnpm infra:apply-emulated` fails if a listed gap no longer
reproduces).

| Gap | Upstream |
| --- | --- |
| S3 lifecycle configuration does not stabilize (`TransitionDefaultMinimumObjectSize`) | [#41](https://github.com/moriyoshi/winterbaume/issues/41) |
| DynamoDB deletion protection is ignored | [#42](https://github.com/moriyoshi/winterbaume/issues/42) |
| DynamoDB server-side encryption cannot be read back | [#43](https://github.com/moriyoshi/winterbaume/issues/43) |
| Lambda resource policy conditions are discarded | [#44](https://github.com/moriyoshi/winterbaume/issues/44) |
| Lambda partial batch response setting (and `ScalingConfig`) is discarded | [#45](https://github.com/moriyoshi/winterbaume/issues/45) |
| Lambda mapping list ignores the function and event source filters | [#46](https://github.com/moriyoshi/winterbaume/issues/46) |
| EventBridge retry policy and dead-letter config are discarded | [#47](https://github.com/moriyoshi/winterbaume/issues/47) |
| Lambda Invoke does not execute the uploaded ZIP (feature request) | [#48](https://github.com/moriyoshi/winterbaume/issues/48) |
| S3 bucket policy is stored but not enforced (feature request) | [#49](https://github.com/moriyoshi/winterbaume/issues/49) |
| S3 ownership-control deletion is ignored | [#50](https://github.com/moriyoshi/winterbaume/issues/50) |
| Tag readback: DynamoDB `CreateTable` drops tags | [#51](https://github.com/moriyoshi/winterbaume/issues/51) |
| Tag readback: IAM `CreateRole` / `GetRole` omit `Role.Tags` | [#52](https://github.com/moriyoshi/winterbaume/issues/52) |
| Tag readback: S3 `CreateBucket` drops `CreateBucketConfiguration.Tags` | [#53](https://github.com/moriyoshi/winterbaume/issues/53) |
| Tag readback: Lambda event source mapping has no ARN and cannot be tagged | [#54](https://github.com/moriyoshi/winterbaume/issues/54) |
| S3 percent-decoding corrupts UTF-8 keys | [#58](https://github.com/moriyoshi/winterbaume/issues/58) (fixed at v0.2.9) |
| DynamoDB conditional updates are not atomic with their checks | [#61](https://github.com/moriyoshi/winterbaume/issues/61) (fixed at v0.2.10) |
| Lambda `VpcConfig` is accepted but never returned | [#62](https://github.com/moriyoshi/winterbaume/issues/62) (fixed at v0.2.10) |
| SQS FIFO `DeduplicationScope` / `FifoThroughputLimit` are discarded | [#64](https://github.com/moriyoshi/winterbaume/issues/64) (fixed at v0.2.10) |
| SQS FIFO delivers more of a group while a message is in flight | [#65](https://github.com/moriyoshi/winterbaume/issues/65) (fixed at v0.2.10) |
| SQS FIFO receive omits `MessageGroupId`, `MessageDeduplicationId`, `SequenceNumber` | [#66](https://github.com/moriyoshi/winterbaume/issues/66) (fixed at v0.2.10) |
| EventBridge `PutRule` drops `Tags` | [#67](https://github.com/moriyoshi/winterbaume/issues/67) (fixed at v0.2.10) |
| CloudWatch `DescribeAlarms` omits `TreatMissingData`; new alarms start in `OK` | [#68](https://github.com/moriyoshi/winterbaume/issues/68) (fixed at v0.2.10) |
| CloudWatch rejects AWS JSON 1.0 protocol requests (`MissingAction`); AWS CLI 2.35 cannot call it | [#69](https://github.com/moriyoshi/winterbaume/issues/69) (fixed at v0.2.10) |
| S3 presigned (query-string SigV4) requests are not routed: 404 `UnknownService` (found 2026-11-25 at v0.2.9; `blob-s3` presign is covered only by the published-vector unit test, not against the emulator) | [#81](https://github.com/moriyoshi/winterbaume/issues/81) |
| S3 unsigned requests return 404 JSON `UnknownService` instead of 403 `AccessDenied` (found in the M4d spike at v0.2.9) | [#82](https://github.com/moriyoshi/winterbaume/issues/82) |
| S3 ranged GET in server release 0.2.6 | [#29](https://github.com/moriyoshi/winterbaume/issues/29) (closed; fixed at the pinned revision) |

## Lambda VPC configuration is discarded

Fixed at v0.2.10 (#62); the text below is historical.

At both historical revision `69fed1d7fb0eb9a2738ff3274197c7591129c4cb` and v0.2.9, Lambda
`CreateFunction` accepts `VpcConfig` containing `SubnetIds: ["subnet-12345678"]` and
`SecurityGroupIds: ["sg-12345678"]` with HTTP 201, but both the create response and
subsequent `GetFunction` HTTP 200 omit `VpcConfig`. There is no error. The emulator cannot
prove Lambda networking or its provider readback. The apply harness reproduces this gap on
every run before omitting only the VPC block in its temporary module copy; the network role
policy and all other generated resources remain in the emulated apply. Terraform mock tests
cover the intended block. Filed as [issue #62](https://github.com/moriyoshi/winterbaume/issues/62).

## FIFO settings and delivery are incomplete

Fixed at v0.2.10 (#64 to #66); the text below is historical.

Reproduced at v0.2.9 (originally observed at `79c452d2bb2844abf771cfa4a497275c24b46489`, 2026-11-21), loopback SQS JSON API. `CreateQueue` for `fifo-probe.fifo` with `FifoQueue=true`,
`ContentBasedDeduplication=false`, `DeduplicationScope=messageGroup` and
`FifoThroughputLimit=perMessageGroupId` returned HTTP 200. `GetQueueAttributes(All)` returned
`FifoQueue=true`, but `DeduplicationScope=queue` and `FifoThroughputLimit=perQueue`; the
requested high-throughput attributes were discarded. Two `SendMessage` calls with the same
`MessageGroupId=group` and distinct deduplication IDs returned HTTP 200. After receiving the
first with `MaxNumberOfMessages=1` and leaving it in flight, a second `ReceiveMessage` returned
the next message from the same group immediately. Returned `Attributes(All)` omitted both
`MessageGroupId` and `MessageDeduplicationId`. A repeated deduplication ID did return the first
message ID, so basic five-minute send deduplication was observed; this does not establish its
scope, timing or delivery correctness. No AWS error text was returned: the service silently
accepted the requests and returned the incorrect values above. FIFO ordering, group exclusion,
Lambda event attributes, high-throughput settings and full Terraform convergence remain unproven
by this emulator; mock-provider tests and ultimately a real AWS deployment must cover them.
Filed as [#64](https://github.com/moriyoshi/winterbaume/issues/64),
[#65](https://github.com/moriyoshi/winterbaume/issues/65) and
[#66](https://github.com/moriyoshi/winterbaume/issues/66).

## S3 Tables is not emulated

Noted at v0.2.9 for the M4i Terraform piece (not reproduced against a running emulator and not filed: the brief said not to file issues). winterbaume has no S3 Tables service, so the `aws_s3tables_table_bucket`, `aws_s3tables_namespace` and `aws_s3tables_table_bucket_policy` resources of `infra/modules/aws/s3tables` cannot be planned or applied against it, and the Iceberg REST endpoint (`s3tables.<region>.amazonaws.com/iceberg`) does not exist locally. ECR is also absent (the `aws_ecr_repository`, lifecycle and repository policy of the `lambda-app` image functions, M4i), and `package_type = Image` Lambda functions cannot run an image in the emulator either. The local archive path uses Lakekeeper with winterbaume only as its S3 object store. Coverage for the module is Terraform mock-provider tests, `terraform validate` on both pinned provider versions, the mutation suite, and ultimately a real account (M4m).

## ECR and container-image Lambda functions are not emulated

Noted at v0.2.9 for the rest of M4i (the Terraform side was exercised through mock-provider tests and `terraform validate`; the emulator probe was run for the parts it supports). winterbaume has no ECR service, so the `aws_ecr_repository`, `aws_ecr_lifecycle_policy` and `aws_ecr_repository_policy` of `infra/modules/aws/lambda-app` cannot be planned or applied against it, and a function with `package_type = "Image"` needs a pushed image that no local registry provides. The emulated probe therefore covers only the ZIP functions: with `ERRTRAQ_PROBE_PROVIDER=6.73.0` the `s3` module (no staging purpose or lifecycle rule, `archive-overflow/` prefix) and `lambda-app` (ZIP functions with the new `package_type` and `ephemeral_storage` arguments) applied, and `sqs` applied; `lambda-app` kept its known second-plan drift and Invoke gap (#48), `dynamodb-protected` failed with `ResourceInUseException` from the emulator's state, and `generated-root` (the plain shared stack, which contains no archive) hit the spawn timeout both while the mutation suite shared the machine and again on an idle one; whether that predates M4i was not checked against the previous commit. Everything specific to the archive role (image URI, image command, ECR repository policy, S3 Tables, EventBridge to the archive function) is checked by `terraform validate`, the module and root mock tests, the mutation suite and the local arm64 image smoke test, and ultimately by a real account (M4m).
