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
      read: ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"],
      write:
        selection === "kv"
          ? ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"]
          : [
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:ConditionCheckItem",
            ],
      delete: ["dynamodb:DeleteItem"],
    }[capability];
    if (!arn || !actions)
      throw new Error(`Unsupported ${selection} ${capability} policy`);
    statements = [
      statement(
        actions,
        capability === "read" ? [arn, `${arn}/index/*`] : [arn],
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
