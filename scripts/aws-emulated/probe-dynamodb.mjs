import { assert, check, client, unique } from "./client.mjs";
export async function probeDynamo(endpoint) {
  const c = client(endpoint),
    TableName = unique(),
    results = {};
  try {
    await c.dynamo("CreateTable", {
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
        { AttributeName: "GSI1PK", AttributeType: "S" },
        { AttributeName: "GSI1SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    });
    const item = (sk) => ({
      PK: { S: "p" },
      SK: { S: sk },
      GSI1PK: { S: "g" },
      GSI1SK: { S: sk },
    });
    await c.dynamo("PutItem", { TableName, Item: item("a") });
    await c.dynamo("PutItem", { TableName, Item: item("b") });
    await check(results, "gsi-query-both-directions", async () => {
      const q = (forward) =>
        c.dynamo("Query", {
          TableName,
          IndexName: "gsi1",
          KeyConditionExpression: "GSI1PK = :p",
          ExpressionAttributeValues: { ":p": { S: "g" } },
          ScanIndexForward: forward,
        });
      const a = await q(true),
        b = await q(false);
      assert.deepEqual(
        a.Items.map((x) => x.SK.S),
        ["a", "b"],
      );
      assert.deepEqual(
        b.Items.map((x) => x.SK.S),
        ["b", "a"],
      );
    });
    await check(results, "transactions-condition-check", async () => {
      await c.dynamo("TransactWriteItems", {
        TransactItems: [
          {
            ConditionCheck: {
              TableName,
              Key: { PK: { S: "p" }, SK: { S: "a" } },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          { Put: { TableName, Item: { PK: { S: "p" }, SK: { S: "tx" } } } },
        ],
      });
      let rejected = false;
      try {
        await c.dynamo("TransactWriteItems", {
          TransactItems: [
            {
              ConditionCheck: {
                TableName,
                Key: { PK: { S: "p" }, SK: { S: "missing" } },
                ConditionExpression: "attribute_exists(PK)",
              },
            },
            { Put: { TableName, Item: { PK: { S: "p" }, SK: { S: "no" } } } },
          ],
        });
      } catch {
        rejected = true;
      }
      assert.ok(rejected, "condition did not abort transaction");
      const got = await c.dynamo("GetItem", {
        TableName,
        Key: { PK: { S: "p" }, SK: { S: "no" } },
        ConsistentRead: true,
      });
      assert.equal(got.Item, undefined);
    });
    await check(results, "conditional-update-add-if-not-exists", async () => {
      const key = { PK: { S: "p" }, SK: { S: "counter" } };
      const params = {
        TableName,
        Key: key,
        UpdateExpression:
          "SET expiresAt = if_not_exists(expiresAt, :ttl) ADD n :one",
        ConditionExpression: "attribute_not_exists(n) OR n < :limit",
        ExpressionAttributeValues: {
          ":ttl": { N: "123" },
          ":one": { N: "1" },
          ":limit": { N: "2" },
        },
        ReturnValues: "ALL_NEW",
      };
      const a = await c.dynamo("UpdateItem", params);
      const b = await c.dynamo("UpdateItem", params);
      assert.equal(a.Attributes.n.N, "1");
      assert.equal(b.Attributes.n.N, "2");
      await assert.rejects(() => c.dynamo("UpdateItem", params));
    });
    await check(results, "batch-get-consistent-read", async () => {
      const r = await c.dynamo("BatchGetItem", {
        RequestItems: {
          [TableName]: {
            Keys: [
              { PK: { S: "p" }, SK: { S: "a" } },
              { PK: { S: "p" }, SK: { S: "b" } },
            ],
            ConsistentRead: true,
          },
        },
      });
      assert.equal(r.Responses[TableName].length, 2);
      const v = await c.dynamo("GetItem", {
        TableName,
        Key: { PK: { S: "p" }, SK: { S: "a" } },
        ConsistentRead: true,
      });
      assert.equal(v.Item.SK.S, "a");
    });
    await check(results, "ttl-attribute", async () => {
      await c.dynamo("UpdateTimeToLive", {
        TableName,
        TimeToLiveSpecification: { Enabled: true, AttributeName: "expiresAt" },
      });
      const r = await c.dynamo("DescribeTimeToLive", { TableName });
      assert.equal(r.TimeToLiveDescription.AttributeName, "expiresAt");
    });
  } finally {
    await c.dynamo("DeleteTable", { TableName }).catch(() => {});
  }
  return results;
}
