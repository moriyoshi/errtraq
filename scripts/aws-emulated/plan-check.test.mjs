import { describe, expect, it } from "vitest";
import { assertRepeatPlan } from "./plan-check.mjs";

describe("repeat-plan gap filtering", () => {
  const gaps = {
    "tags-dynamodb": {},
  };
  it("permits only documented differing fields", () => {
    const plan = {
      resource_changes: [
        {
          address: "module.store.aws_dynamodb_table.this",
          mode: "managed",
          type: "aws_dynamodb_table",
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
      "tags-dynamodb",
    ]);
    plan.resource_changes[0].change.after.id = "changed";
    expect(() => assertRepeatPlan(plan, gaps)).toThrow();
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
        address: "module.store.aws_dynamodb_table.this",
        mode: "managed",
        type: "aws_dynamodb_table",
        change: {
          actions: ["update"],
          before: { id: "x", tags_all: {} },
          after: { id: "x", tags_all: { app: "errtraq", unexpected: "yes" } },
        },
      },
    ],
  };
  expect(() =>
    assertRepeatPlan(plan, { "tags-dynamodb": {} }, { app: "errtraq" }),
  ).toThrow();
});
