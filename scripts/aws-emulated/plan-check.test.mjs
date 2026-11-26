import { describe, expect, it } from "vitest";
import { assertRepeatPlan } from "./plan-check.mjs";

describe("repeat plan", () => {
  const resource = (type, actions) => ({
    resource_changes: [
      { address: `x.${type}`, mode: "managed", type, change: { actions } },
    ],
  });
  it("accepts no-ops and data sources", () => {
    expect(() =>
      assertRepeatPlan(resource("aws_sqs_queue", ["no-op"])),
    ).not.toThrow();
    expect(() =>
      assertRepeatPlan({
        resource_changes: [
          {
            address: "d",
            mode: "data",
            type: "aws_x",
            change: { actions: ["read"] },
          },
        ],
      }),
    ).not.toThrow();
  });
  it("rejects any managed change, including the former readback gaps", () => {
    for (const type of [
      "aws_cloudwatch_event_rule",
      "aws_cloudwatch_metric_alarm",
      "aws_dynamodb_table",
      "aws_lambda_function",
    ])
      expect(() => assertRepeatPlan(resource(type, ["update"]))).toThrow(
        "unexpected repeat-plan change",
      );
    expect(() =>
      assertRepeatPlan(resource("aws_sqs_queue", ["delete", "create"])),
    ).toThrow();
  });
});

describe("deployment change plans", () => {
  it("checks exact queue and function creations and deletions", async () => {
    const { assertQueueTransition, assertFunctionTransition } = await import(
      "./plan-check.mjs"
    );
    const oldView = {
      triggers: [{ kind: "queue", physical: "shared" }],
      functions: [{ id: "old" }],
    };
    const newView = {
      triggers: [{ kind: "queue", physical: "ingest" }],
      functions: [{ id: "new" }],
    };
    const entries = [];
    for (const [key, action] of [
      ["shared", "delete"],
      ["ingest", "create"],
    ])
      for (const [module, type, name] of [
        ["queue", "aws_sqs_queue", "queue"],
        ["queue", "aws_sqs_queue", "dlq"],
        ["queue", "aws_cloudwatch_metric_alarm", "dlq_messages"],
        ["queue", "aws_cloudwatch_metric_alarm", "queue_age"],
        ["platform", "aws_lambda_event_source_mapping", "queue"],
      ])
        entries.push({
          mode: "managed",
          type,
          address: `module.${module}.${type}.${name}["${key}"]`,
          change: { actions: [action] },
        });
    const plan = { resource_changes: entries };
    expect(() => assertQueueTransition(plan, oldView, newView)).not.toThrow();
    entries.pop();
    expect(() => assertQueueTransition(plan, oldView, newView)).toThrow();
    const fns = {
      resource_changes: [
        {
          mode: "managed",
          type: "aws_lambda_function",
          index: "old",
          change: { actions: ["delete"] },
        },
        {
          mode: "managed",
          type: "aws_lambda_function",
          index: "new",
          change: { actions: ["create"] },
        },
      ],
    };
    expect(() => assertFunctionTransition(fns, oldView, newView)).not.toThrow();
    fns.resource_changes.pop();
    expect(() => assertFunctionTransition(fns, oldView, newView)).toThrow();
  });
});
