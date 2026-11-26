import assert from "node:assert/strict";
import { unique } from "./client.mjs";

/** Each check must fail as soon as the reason for its exception disappears. */
export function assertPartialBatchSupport(mapping) {
  assert.ok(
    mapping?.FunctionResponseTypes?.includes("ReportBatchItemFailures"),
    "Lambda mapping must retain ReportBatchItemFailures",
  );
}
/**
 * Issue #61 (fixed at v0.2.10): exactly one conditional update may succeed on each absent key,
 * however many race. The old race reproduced in 7-30% of rounds, so 150 rounds make a regression
 * that goes unnoticed negligible.
 */
export async function assertConditionalUpdateAtomic(
  c,
  rounds = 150,
  attempts = 200,
) {
  const TableName = unique();
  await c.dynamo("CreateTable", {
    TableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "PK", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }],
  });
  try {
    for (let round = 0; round < rounds; round++) {
      const request = {
        TableName,
        Key: { PK: { S: `race-${round}` } },
        UpdateExpression: "SET #v = :one",
        ConditionExpression: "attribute_not_exists(#v)",
        ExpressionAttributeNames: { "#v": "v" },
        ExpressionAttributeValues: { ":one": { N: "1" } },
      };
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () => c.dynamo("UpdateItem", request)),
      );
      for (const result of results)
        if (
          result.status === "rejected" &&
          !String(result.reason).includes("ConditionalCheckFailedException")
        )
          throw result.reason;
      const winners = results.filter(
        (result) => result.status === "fulfilled",
      ).length;
      assert.equal(
        winners,
        1,
        `conditional update must have exactly one winner (round ${round}, issue #61)`,
      );
    }
  } finally {
    await c.dynamo("DeleteTable", { TableName });
  }
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
    assert.equal(
      lifecycle.headers.get("x-amz-transition-default-minimum-object-size"),
      "all_storage_classes_128K",
      "S3 lifecycle header must be preserved",
    );
    await c.request("s3", `/${name}?ownershipControls`, {
      method: "PUT",
      headers: { "content-type": "application/xml" },
      body: "<OwnershipControls><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>",
    });
    await c.request("s3", `/${name}?ownershipControls`, { method: "DELETE" });
    await assert.rejects(
      () => c.request("s3", `/${name}?ownershipControls`),
      /s3 404:/,
      "S3 ownership controls must be gone after deletion",
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
    assert.equal(description.Table.DeletionProtectionEnabled, true);
    await assert.rejects(
      () => c.dynamo("DeleteTable", { TableName: name }),
      /protected against deletion/i,
    );
    await c.dynamo("UpdateTable", {
      TableName: name,
      DeletionProtectionEnabled: false,
    });
    await c.dynamo("DeleteTable", { TableName: name });
    table = false;
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
    const target = targets.Targets?.find((target) => target.Id === "probe");
    assert.deepEqual(target.RetryPolicy, {
      MaximumEventAgeInSeconds: 100,
      MaximumRetryAttempts: 2,
    });
    assert.equal(
      target.DeadLetterConfig.Arn,
      `arn:aws:sqs:us-east-1:${account}:${name}`,
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
