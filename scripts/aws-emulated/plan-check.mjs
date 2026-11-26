import assert from "node:assert/strict";

/** At v0.2.10 no readback gap remains: a repeat plan must change nothing. */
export function assertRepeatPlan(plan) {
  for (const change of plan.resource_changes ?? []) {
    if (
      change.mode !== "managed" ||
      JSON.stringify(change.change.actions) === '["no-op"]'
    )
      continue;
    assert.fail(
      `unexpected repeat-plan change at ${change.address}: ${JSON.stringify(change.change.actions)}`,
    );
  }
}

export function assertQueueTransition(plan, before, after) {
  const oldKeys = new Set(
    before.triggers.filter((t) => t.kind === "queue").map((t) => t.physical),
  );
  const newKeys = new Set(
    after.triggers.filter((t) => t.kind === "queue").map((t) => t.physical),
  );
  const expected = [];
  for (const [keys, other, action] of [
    [oldKeys, newKeys, "delete"],
    [newKeys, oldKeys, "create"],
  ]) {
    for (const key of keys)
      if (!other.has(key))
        for (const [module, type, name] of [
          ["queue", "aws_sqs_queue", "queue"],
          ["queue", "aws_sqs_queue", "dlq"],
          ["queue", "aws_cloudwatch_metric_alarm", "dlq_messages"],
          ["queue", "aws_cloudwatch_metric_alarm", "queue_age"],
          ["platform", "aws_lambda_event_source_mapping", "queue"],
        ])
          expected.push(
            `${action} module.${module}.${type}.${name}[${JSON.stringify(key)}]`,
          );
  }
  const actual = [];
  for (const resource of plan.resource_changes ?? []) {
    if (resource.mode !== "managed") continue;
    const actions = resource.change.actions;
    if (
      [
        "aws_sqs_queue",
        "aws_lambda_event_source_mapping",
        "aws_cloudwatch_metric_alarm",
      ].includes(resource.type)
    ) {
      for (const action of actions)
        if (action === "create" || action === "delete")
          actual.push(`${action} ${resource.address}`);
    } else if (actions.includes("delete"))
      throw new Error(
        `Unexpected deletion or replacement: ${resource.address}`,
      );
    else if (
      actions.includes("create") &&
      resource.type !== "aws_iam_role_policy"
    )
      throw new Error(`Unexpected new resource: ${resource.address}`);
  }
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    "queue transition differs from derived routes",
  );
}
export function assertFunctionTransition(plan, before, after) {
  const oldIds = new Set(before.functions.map((fn) => fn.id)),
    newIds = new Set(after.functions.map((fn) => fn.id));
  const expected = [];
  for (const id of oldIds) if (!newIds.has(id)) expected.push(`delete ${id}`);
  for (const id of newIds) if (!oldIds.has(id)) expected.push(`create ${id}`);
  const actual = [];
  for (const resource of plan.resource_changes ?? []) {
    if (resource.mode !== "managed" || resource.type !== "aws_lambda_function")
      continue;
    for (const action of resource.change.actions)
      if (action === "create" || action === "delete")
        actual.push(`${action} ${resource.index}`);
  }
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    "function transition differs from derived physical functions",
  );
}
