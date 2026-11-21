import { readFile } from "node:fs/promises";

/** Read the resource shape from the HCL itself and fail closed if its template changes. */
export async function moduleShapes() {
  const ddb = await readFile(
    new URL("../../infra/modules/aws/dynamodb/main.tf", import.meta.url),
    "utf8",
  );
  const ddbVariables = await readFile(
    new URL("../../infra/modules/aws/dynamodb/variables.tf", import.meta.url),
    "utf8",
  );
  const sqs = await readFile(
    new URL("../../infra/modules/aws/sqs/main.tf", import.meta.url),
    "utf8",
  );
  function capture(source, expression) {
    const result = source.match(expression);
    if (!result) throw new Error(`Unsupported module shape: ${expression}`);
    return result[1];
  }
  const pk = capture(ddb, /hash_key\s*=\s*"([^"]+)"/);
  const sk = capture(ddb, /range_key\s*=\s*"([^"]+)"/);
  if (
    !ddb.includes('projection_type = "KEYS_ONLY"') ||
    !ddb.includes("/indexes.json") ||
    !ddb.includes('"ttlEpoch" : "expiresAt"')
  )
    throw new Error("Unsupported DynamoDB module template");
  const indexes = JSON.parse(
    await readFile(
      new URL("../../infra/modules/aws/dynamodb/indexes.json", import.meta.url),
      "utf8",
    ),
  );
  const attributes = [pk, sk];
  const gsis = Object.entries(indexes).map(([name, keys]) => {
    attributes.push(keys.hash, keys.range);
    return {
      IndexName: name,
      KeySchema: [
        { AttributeName: keys.hash, KeyType: "HASH" },
        { AttributeName: keys.range, KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "KEYS_ONLY" },
    };
  });
  return {
    table: {
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: attributes.map((AttributeName) => ({
        AttributeName,
        AttributeType: "S",
      })),
      KeySchema: [
        { AttributeName: pk, KeyType: "HASH" },
        { AttributeName: sk, KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: gsis,
    },
    kv: {
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [pk, sk].map((AttributeName) => ({
        AttributeName,
        AttributeType: "S",
      })),
      KeySchema: [
        { AttributeName: pk, KeyType: "HASH" },
        { AttributeName: sk, KeyType: "RANGE" },
      ],
    },
    dlq: {
      MessageRetentionPeriod: capture(
        sqs,
        /message_retention_seconds\s*=\s*(1209600)/,
      ),
    },
    metadata: {
      PK: { S: capture(ddb, /PK = \{ S = "([^"]+)" \}/) },
      SK: { S: capture(ddb, /SK = \{ S = "([^"]+)" \}/) },
      projectTimeShards: {
        N: capture(
          ddbVariables,
          /variable "index_shards" \{[\s\S]*?default\s*=\s*(\d+)/,
        ),
      },
    },
    ttl: "ttlEpoch",
    kvTtl: "expiresAt",
    queue: {
      MessageRetentionPeriod: capture(
        sqs,
        /message_retention_seconds\s*=\s*(345600)/,
      ),
      MaximumMessageSize: capture(sqs, /max_message_size\s*=\s*(\d+)/),
      VisibilityTimeout: "30",
    },
  };
}
