import { describe, expect, it } from "vitest";
import { assertRepeatPlan } from "./plan-check.mjs";

describe("repeat-plan gap filtering", () => {
  const gaps = {
    "tags-eventbridge": {},
  };
  it("permits only documented differing fields", () => {
    const plan = {
      resource_changes: [
        {
          address: "module.platform.aws_cloudwatch_event_rule.this",
          mode: "managed",
          type: "aws_cloudwatch_event_rule",
          change: {
            actions: ["update"],
            before: { id: "x", tags_all: {} },
            after: {
              id: "x",
              tags_all: { app: "errtraq" },
            },
          },
        },
      ],
    };
    expect([...assertRepeatPlan(plan, gaps, { app: "errtraq" })]).toEqual([
      "tags-eventbridge",
    ]);
    plan.resource_changes[0].change.after.id = "changed";
    expect(() => assertRepeatPlan(plan, gaps)).toThrow();
  });
  it("requires the named EventBridge tag exception", () => {
    const plan = {
      resource_changes: [
        {
          address: "rule",
          mode: "managed",
          type: "aws_cloudwatch_event_rule",
          change: {
            actions: ["update"],
            before: { tags_all: {} },
            after: { tags_all: { app: "errtraq" } },
          },
        },
      ],
    };
    expect(() => assertRepeatPlan(plan, {}, { app: "errtraq" })).toThrow(
      "Undeclared",
    );
    expect([
      ...assertRepeatPlan(plan, { "tags-eventbridge": {} }, { app: "errtraq" }),
    ]).toEqual(["tags-eventbridge"]);
  });
  it("rejects replacements and undocumented changes", () => {
    const plan = {
      resource_changes: [
        {
          address: "x",
          mode: "managed",
          type: "aws_sqs_queue",
          change: { actions: ["delete", "create"], before: {}, after: {} },
        },
      ],
    };
    expect(() => assertRepeatPlan(plan, gaps)).toThrow();
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

it("does not hide unrelated tag changes behind a known gap", () => {
  const plan = {
    resource_changes: [
      {
        address: "module.platform.aws_cloudwatch_event_rule.this",
        mode: "managed",
        type: "aws_cloudwatch_event_rule",
        change: {
          actions: ["update"],
          before: { id: "x", tags_all: {} },
          after: { id: "x", tags_all: { app: "errtraq", unexpected: "yes" } },
        },
      },
    ],
  };
  expect(() =>
    assertRepeatPlan(plan, { "tags-eventbridge": {} }, { app: "errtraq" }),
  ).toThrow();
});

it("no longer tolerates tag readback drift on resources whose gaps were fixed", () => {
  for (const type of [
    "aws_dynamodb_table",
    "aws_iam_role",
    "aws_s3_bucket",
    "aws_lambda_event_source_mapping",
  ]) {
    const plan = {
      resource_changes: [
        {
          address: `x.${type}`,
          mode: "managed",
          type,
          change: {
            actions: ["update"],
            before: { tags_all: {} },
            after: { tags_all: { app: "errtraq" } },
          },
        },
      ],
    };
    expect(() =>
      assertRepeatPlan(plan, { "tags-eventbridge": {} }, { app: "errtraq" }),
    ).toThrow("unexpected repeat-plan difference");
  }
});

describe("CloudWatch alarm readback exception", () => {
  const change = (before, after) => ({
    resource_changes: [
      {
        address: "alarm",
        mode: "managed",
        type: "aws_cloudwatch_metric_alarm",
        change: { actions: ["update"], before, after },
      },
    ],
  });
  const base = { period: 300, threshold: 900 };
  const gaps = { "cloudwatch-alarm-readback": {} };
  it("permits only the two unreturned fields at their known values", () => {
    const plan = change(
      { ...base, datapoints_to_alarm: 0, treat_missing_data: "missing" },
      { ...base, datapoints_to_alarm: 3, treat_missing_data: "notBreaching" },
    );
    expect([...assertRepeatPlan(plan, gaps)]).toEqual([
      "cloudwatch-alarm-readback",
    ]);
    expect(() => assertRepeatPlan(plan, {})).toThrow("Undeclared");
  });
  it("rejects other alarm drift and unexpected desired values", () => {
    expect(() =>
      assertRepeatPlan(
        change(
          { ...base, datapoints_to_alarm: 0, treat_missing_data: "missing" },
          {
            ...base,
            threshold: 1,
            datapoints_to_alarm: 1,
            treat_missing_data: "notBreaching",
          },
        ),
        gaps,
      ),
    ).toThrow();
    expect(() =>
      assertRepeatPlan(
        change(
          { ...base, datapoints_to_alarm: 0, treat_missing_data: "missing" },
          { ...base, datapoints_to_alarm: 1, treat_missing_data: "breaching" },
        ),
        gaps,
      ),
    ).toThrow();
  });
});
