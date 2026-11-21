# Winterbaume gaps found by Terraform provider probes

Target: source revision `69fed1d7fb0eb9a2738ff3274197c7591129c4cb` (server 0.2.8),
unless stated otherwise. `pnpm infra:probe-emulated` creates an isolated local server,
uses the real AWS provider with loopback-only endpoints and no AWS credentials, and saves
Terraform apply and provider debug logs in an ignored scratch directory. Runs are capped
at 90 seconds per apply; a timeout is a probe limit, not an AWS error response. The probe
is an inventory: it does not implement the complete M3a2 apply/assert/destroy workflow.
The existing `pnpm infra:validate` mock-provider checks remain in place.

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
| Generated AWS stack | Apply reached the S3 lifecycle waiter and exceeded the probe timeout; complete root application remains unproven. |
| STS | GetCallerIdentity succeeded in the M3a direct control-plane probe. |

## S3 lifecycle configuration does not stabilize

- Resource: `aws_s3_bucket_lifecycle_configuration` in the unchanged S3 module. The
  provider sends `PutBucketLifecycleConfiguration` with header
  `x-amz-transition-default-minimum-object-size: all_storage_classes_128K`. Winterbaume
  responds HTTP 200. Repeated `GetBucketLifecycleConfiguration` returns HTTP 200 and
  the configured rules, but omits that response header.
- Observed error: no AWS error; the provider repeatedly waits for equality and the harness
  terminates the apply after 90 seconds with `spawnSync terraform ETIMEDOUT`. The provider's
  lifecycle equality check compares the requested and returned minimum-object-size values.
  This blocks a complete S3 module apply and can block the generated stack.

## DynamoDB server-side encryption cannot be read back

- Resource: `aws_dynamodb_table`, `server_side_encryption { enabled = true }`.
  The provider sends `CreateTable` with `SSESpecification: { "Enabled": true }`;
  `DescribeTable` returns no `SSEDescription` field. There is no error. This probe
  cannot establish that the requested encryption setting is honored; the emulator's
  in-memory storage cannot demonstrate encryption at rest.

## DynamoDB deletion protection is ignored

- Resource: `aws_dynamodb_table`, `deletion_protection_enabled: true`. With
  providers 6.30.0 and 6.73.0, the production-mode module applies successfully, but
  `DescribeTable` reports `DeletionProtectionEnabled: false`. `terraform destroy`
  then succeeds and deletes that table. There is no error. A direct `CreateTable`
  request carrying `DeletionProtectionEnabled: true` reproduced the false readback
  and successful `DeleteTable` independently. Production deletion protection cannot
  be verified against this revision.

## Lambda resource policy conditions are discarded

- Resource: `aws_lambda_permission` for a public function URL. `AddPermission` accepts
  `FunctionUrlAuthType: NONE` and, for the second permission,
  `InvokedViaFunctionUrl: true`. The HTTP 201 responses and subsequent `GetPolicy` retain
  the actions and principals but omit the corresponding conditions. There is no error.
- Function URL creation also inserted two additional public statements in the observed
  function policy. The mock cannot establish the exact intended URL-only permissions or
  their enforcement.

## Lambda partial batch response setting is discarded

- Resource: `aws_lambda_event_source_mapping`. The provider's
  `CreateEventSourceMapping` request includes
  `FunctionResponseTypes: ["ReportBatchItemFailures"]`; the HTTP 202 response and
  `GetEventSourceMapping` omit it. There is no error. A second provider plan proposes an
  in-place update adding `ReportBatchItemFailures` again, so the Lambda module is not
  idempotent against this emulator.
- The observed mapping was also accepted with a queue ARN for a queue that did not exist
  in the standalone module probe. This does not prove AWS event-source validation.

## Lambda mapping list ignores the function filter

- Resource: `aws_lambda_event_source_mapping`. A `ListEventSourceMappings` request
  with `FunctionName` set to one test function returned mappings for that function and
  two other functions. The response was HTTP 200 with no error. Inventory assertions
  must filter returned `FunctionArn` themselves rather than trust this server-side filter.

## EventBridge retry policy is discarded

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

## S3 range requests in server release 0.2.6

- Resource: S3 `GetObject` with `Range: bytes=1-3` on a six-byte object. Server release
  0.2.6 returns HTTP 200 and all six bytes, rather than HTTP 206 and the requested three.
  A separately signed AWS CLI request reproduced this; there is no error response.
  The pinned newer source revision used by the harness passes this probe.

The results do not prove IAM, encryption at rest, authorization or the behavior of a real
AWS account. M3a2 still needs API-level assertions, generated-root variants, idempotence,
change plans, destruction and protection checks for the paths the emulator can exercise.
