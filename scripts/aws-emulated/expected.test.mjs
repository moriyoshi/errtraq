import { describe, expect, it } from "vitest";
import { canonicalPolicy, capabilityPolicy } from "./expected.mjs";

describe("derived capability policy expectations", () => {
  const resources = {
    store: "table",
    kv: "kv",
    blob: "bucket",
    queues: { ingest: "queue" },
  };
  it("scopes queue grants to the required physical queue", () => {
    const policy = capabilityPolicy(
      { selection: "queue", capability: "produce", purpose: "ingest" },
      resources,
    );
    expect(policy.Statement).toEqual([
      { Effect: "Allow", Action: ["sqs:SendMessage"], Resource: "queue" },
    ]);
    expect(() =>
      capabilityPolicy(
        { selection: "queue", capability: "produce", purpose: "other" },
        resources,
      ),
    ).toThrow();
  });
  it("keeps staging policies and table indexes separate", () => {
    const blob = capabilityPolicy(
      { selection: "blob", capability: "write", purpose: "staging" },
      resources,
    );
    expect(blob.Statement[0].Resource).toEqual(["bucket/archive-staging/*"]);
    const read = capabilityPolicy(
      { selection: "store", capability: "read", purpose: "primary" },
      resources,
    );
    expect(read.Statement[0].Resource).toContain(
      "table/index/event-issue-time",
    );
    expect(read.Statement[0].Resource).toHaveLength(12);
  });
  it("limits ingest reads to project key rows", () => {
    expect(
      capabilityPolicy(
        { selection: "store", capability: "key-read", purpose: "primary" },
        resources,
      ).Statement,
    ).toEqual([
      {
        Effect: "Allow",
        Action: ["dynamodb:GetItem"],
        Resource: ["table"],
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["KEY|*"] },
          Null: { "dynamodb:LeadingKeys": "false" },
        },
      },
    ]);
  });
  it("limits event batch writes to event keys", () => {
    const policy = capabilityPolicy(
      { selection: "store", capability: "delete", purpose: "primary" },
      resources,
    );
    expect(policy.Statement).toEqual([
      {
        Effect: "Allow",
        Action: ["dynamodb:BatchWriteItem"],
        Resource: ["table"],
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["EV|*"] },
          Null: { "dynamodb:LeadingKeys": "false" },
        },
      },
    ]);
  });
  it("scopes metadata deletion to metadata keys", () => {
    const policy = capabilityPolicy(
      { selection: "store", capability: "metadata-delete", purpose: "primary" },
      resources,
    );
    expect(policy.Statement).toEqual([
      {
        Effect: "Allow",
        Action: ["dynamodb:DeleteItem"],
        Resource: ["table"],
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
      },
    ]);
  });
  it("normalizes reordered policy fields without hiding missing actions", () => {
    expect(canonicalPolicy({ b: ["b", "a"], a: true })).toEqual({
      a: true,
      b: ["a", "b"],
    });
    expect(canonicalPolicy(["a"])).not.toEqual(canonicalPolicy(["a", "b"]));
  });
});
