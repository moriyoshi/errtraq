import { readFileSync } from "node:fs";

const indexNames = Object.keys(
  JSON.parse(
    readFileSync(
      new URL("../../infra/modules/aws/dynamodb/indexes.json", import.meta.url),
      "utf8",
    ),
  ),
).sort();
/** Policies expected from the module contracts, selected solely by derived grants. */
export function capabilityPolicy(grant, resources) {
  const { selection, capability, purpose } = grant;
  const statement = (Action, Resource, extra = {}) => ({
    Effect: "Allow",
    Action,
    Resource,
    ...extra,
  });
  let statements;
  if (selection === "store" && resources.storeMode === "rds") {
    statements = [statement(["rds-db:connect"], [resources.store])];
  } else if (selection === "store" || selection === "kv") {
    const arn = resources[selection];
    const actions = {
      "key-read": ["dynamodb:GetItem"],
      read: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"],
      write: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"],
      "metadata-delete": ["dynamodb:DeleteItem"],
      delete:
        selection === "kv"
          ? ["dynamodb:DeleteItem"]
          : ["dynamodb:BatchWriteItem"],
    }[capability];
    if (!arn || !actions)
      throw new Error(`Unsupported ${selection} ${capability} policy`);
    statements = [
      statement(
        actions,
        capability === "read" && selection === "store"
          ? [arn, ...indexNames.map((name) => `${arn}/index/${name}`)]
          : [arn],
        capability === "key-read" && selection === "store"
          ? {
              Condition: {
                "ForAllValues:StringLike": {
                  "dynamodb:LeadingKeys": ["KEY|*"],
                },
                Null: { "dynamodb:LeadingKeys": "false" },
              },
            }
          : capability === "metadata-delete" && selection === "store"
            ? {
                Condition: {
                  "ForAllValues:StringLike": {
                    "dynamodb:LeadingKeys": [
                      "ORGSLUG|*",
                      "PROJECTSLUG|*",
                      "TOKEN|*",
                      "RELEASE|*",
                      "KEY|*",
                      "KEYID|*",
                      "DEBUG|*",
                      "BUNDLE|*",
                    ],
                  },
                  Null: { "dynamodb:LeadingKeys": "false" },
                },
              }
            : capability === "delete" && selection === "store"
              ? {
                  Condition: {
                    "ForAllValues:StringLike": {
                      "dynamodb:LeadingKeys": ["EV|*"],
                    },
                    Null: { "dynamodb:LeadingKeys": "false" },
                  },
                }
              : {},
      ),
    ];
  } else if (selection === "queue") {
    const arn = resources.queues[purpose];
    const actions = {
      produce: ["sqs:SendMessage"],
      consume: [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes",
      ],
    }[capability];
    if (!arn || !actions)
      throw new Error(`Unsupported queue ${capability} ${purpose} policy`);
    statements = [statement(actions, arn)];
  } else if (selection === "blob") {
    const arn = resources.blob;
    const prefixes =
      purpose === "primary"
        ? ["envelopes/", "payloads/", "artifacts/"]
        : purpose === "staging"
          ? ["archive-staging/"]
          : undefined;
    const actions = {
      read: ["s3:GetObject"],
      write: ["s3:PutObject", "s3:AbortMultipartUpload"],
      delete: ["s3:DeleteObject"],
      list: ["s3:ListBucket"],
    }[capability];
    if (!arn || !prefixes || !actions)
      throw new Error(`Unsupported blob ${capability} ${purpose} policy`);
    const condition = {
      Condition: {
        StringLike: { "s3:prefix": prefixes.map((prefix) => `${prefix}*`) },
      },
    };
    const objects = prefixes.map((prefix) => `${arn}/${prefix}*`);
    statements =
      capability === "list"
        ? [statement(actions, arn, condition)]
        : capability === "read"
          ? [
              statement(actions, objects),
              statement(["s3:ListBucket"], arn, condition),
            ]
          : [statement(actions, objects)];
  } else throw new Error(`Unsupported policy selection ${selection}`);
  return { Version: "2012-10-17", Statement: statements };
}
/** Normalize unordered IAM policy lists and object keys for exact semantic comparison. */
export function canonicalPolicy(value) {
  if (Array.isArray(value))
    return value
      .map(canonicalPolicy)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalPolicy(value[key])]),
    );
  return value;
}
