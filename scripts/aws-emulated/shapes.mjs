import { readFile } from "node:fs/promises";

/** Read the resource shape from the HCL itself and fail closed if its template changes. */
export async function moduleShapes() {
  const ddb = await readFile(
    new URL("../../infra/modules/aws/dynamodb/main.tf", import.meta.url),
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
  const end = Number(capture(ddb, /range\(1,\s*(\d+)\)/));
  for (const text of [
    `"GSI\${i}PK"`,
    `"GSI\${i}SK"`,
    `"gsi\${global_secondary_index.value}"`,
    'projection_type = "ALL"',
    'billing_mode                = "PAY_PER_REQUEST"',
  ]) {
    if (!ddb.includes(text))
      throw new Error(`Unsupported DynamoDB module template: ${text}`);
  }
  const attributes = [pk, sk];
  const gsis = [];
  for (let i = 1; i < end; i++) {
    const hash = `GSI${i}PK`,
      range = `GSI${i}SK`;
    attributes.push(hash, range);
    gsis.push({
      IndexName: `gsi${i}`,
      KeySchema: [
        { AttributeName: hash, KeyType: "HASH" },
        { AttributeName: range, KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    });
  }
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
    ttl: capture(ddb, /attribute_name\s*=\s*"(expiresAt)"/),
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
