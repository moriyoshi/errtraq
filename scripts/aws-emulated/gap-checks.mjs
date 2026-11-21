import assert from "node:assert/strict";
import { unique } from "./client.mjs";

/** Each check must fail as soon as the reason for its exception disappears. */
export function assertS3LifecycleGap(headers) {
  assert.equal(
    headers.get("x-amz-transition-default-minimum-object-size"),
    null,
    "s3-lifecycle gap no longer reproduces; remove the exception",
  );
}
export function assertDeletionProtectionGap(table, deleted) {
  assert.equal(
    table.DeletionProtectionEnabled,
    false,
    "dynamodb-deletion-protection gap no longer reproduces; remove the exception",
  );
  assert.equal(
    deleted,
    true,
    "dynamodb-deletion-protection delete behavior changed; remove the exception",
  );
}
export function assertPartialBatchGap(mapping) {
  assert.ok(
    mapping &&
      !mapping.FunctionResponseTypes?.includes("ReportBatchItemFailures"),
    "lambda-partial-batch gap no longer reproduces; remove the exception",
  );
}
export function assertEventbridgeGap(target) {
  assert.ok(
    target &&
      target.RetryPolicy === undefined &&
      target.DeadLetterConfig === undefined,
    "eventbridge-retry-dlq gap no longer reproduces; remove the exception",
  );
}
export async function checkStandaloneGaps(c) {
  const name = unique();
  let bucket = false,
    table = false;
  try {
    await c.request("s3", `/${name}`, { method: "PUT" });
    bucket = true;
    await c.request("s3", `/${name}?lifecycle`, {
      method: "PUT",
      headers: {
        "x-amz-transition-default-minimum-object-size":
          "all_storage_classes_128K",
        "content-type": "application/xml",
      },
      body: "<LifecycleConfiguration><Rule><ID>probe</ID><Filter><Prefix>probe/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>",
    });
    const lifecycle = await c.request("s3", `/${name}?lifecycle`);
    assertS3LifecycleGap(lifecycle.headers);
    await c.request("s3", `/${name}?ownershipControls`, {
      method: "PUT",
      headers: { "content-type": "application/xml" },
      body: "<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>",
    });
    await c.request("s3", `/${name}?ownershipControls`, { method: "DELETE" });
    let ownership;
    try {
      ownership = await c.request("s3", `/${name}?ownershipControls`);
    } catch (error) {
      if (/s3 404:/.test(String(error)))
        throw new Error(
          "s3-ownership-delete gap no longer reproduces; remove the exception",
        );
      throw error;
    }
    assert.match(
      ownership.text,
      /<ObjectOwnership>BucketOwnerEnforced<\/ObjectOwnership>/,
      "s3-ownership-delete gap no longer reproduces; remove the exception",
    );
    await c.dynamo("CreateTable", {
      TableName: name,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: "PK", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }],
      DeletionProtectionEnabled: true,
    });
    table = true;
    const description = await c.dynamo("DescribeTable", { TableName: name });
    await c.dynamo("DeleteTable", { TableName: name });
    table = false;
    assertDeletionProtectionGap(description.Table, true);
  } finally {
    if (table)
      await c.dynamo("DeleteTable", { TableName: name }).catch(() => {});
    if (bucket)
      await c.request("s3", `/${name}`, { method: "DELETE" }).catch(() => {});
  }
}

export async function checkEventbridgeGap(c, account) {
  const name = unique();
  const call = async (action, body) =>
    JSON.parse(
      (
        await c.request("events", "/", {
          method: "POST",
          headers: {
            "content-type": "application/x-amz-json-1.1",
            "x-amz-target": `AWSEvents.${action}`,
          },
          body: JSON.stringify(body),
        })
      ).text,
    );
  let created = false;
  try {
    await call("PutRule", {
      Name: name,
      ScheduleExpression: "rate(5 minutes)",
    });
    created = true;
    const result = await call("PutTargets", {
      Rule: name,
      Targets: [
        {
          Id: "probe",
          Arn: `arn:aws:lambda:us-east-1:${account}:function:${name}`,
          RetryPolicy: {
            MaximumEventAgeInSeconds: 100,
            MaximumRetryAttempts: 2,
          },
          DeadLetterConfig: { Arn: `arn:aws:sqs:us-east-1:${account}:${name}` },
        },
      ],
    });
    assert.equal(result.FailedEntryCount, 0);
    const targets = await call("ListTargetsByRule", { Rule: name });
    assertEventbridgeGap(
      targets.Targets?.find((target) => target.Id === "probe"),
    );
  } finally {
    if (created) {
      const removed = await call("RemoveTargets", {
        Rule: name,
        Ids: ["probe"],
      });
      assert.equal(removed.FailedEntryCount, 0);
      await call("DeleteRule", { Name: name });
      await assert.rejects(() => call("DescribeRule", { Name: name }));
    }
  }
}
