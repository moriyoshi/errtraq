import type {
  EventId,
  Issue,
  IssueId,
  Occurrence,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { issueMutableAttributes } from "./issue-item.js";
import { DynamoStore } from "./runtime.js";

const projectId = "project" as ProjectId,
  issueId = "issue" as IssueId,
  eventId = "event" as EventId;
const timestamp = "2025-01-01T00:00:00.000Z" as Timestamp;
const occurrence: Occurrence = {
  projectId,
  issueId,
  eventId,
  timestamp,
  receivedAt: timestamp,
  fingerprint: "fp",
  title: "title",
  culprit: "",
  level: "error",
  type: "error",
  metadata: {},
};
const event: StoredEvent = {
  projectId,
  issueId,
  eventId,
  timestamp,
  receivedAt: timestamp,
  level: "error",
  tags: {},
  payload: {},
};
const issue = (count: number): Issue => ({
  ...occurrence,
  id: issueId,
  status: "unresolved",
  firstSeen: timestamp,
  lastSeen: timestamp,
  count,
  lastEventId: eventId,
  lastEventReceivedAt: timestamp,
});
const row = (count: number) => ({
  data: { S: JSON.stringify(issue(count)) },
  count: { N: String(count) },
  ...issueMutableAttributes(issue(count)),
});
describe("DynamoDB recordEvent", () => {
  it("rejects a group exceeding the transaction byte limit before writing", async () => {
    let writes = 0;
    const large = "x".repeat(390000);
    const fetcher: typeof fetch = async (_url, init) => {
      const target = new Headers(init?.headers).get("x-amz-target");
      const body = JSON.parse(String(init?.body));
      if (target === "DynamoDB_20120810.GetItem")
        return Response.json(
          body.Key.PK.S === "META|schema"
            ? { Item: { projectTimeShards: { N: "4" } } }
            : {},
        );
      writes++;
      return Response.json({});
    };
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
      fetch: fetcher,
    });
    const group = Array.from({ length: 10 }, (_, index) => {
      const id = `large-${index}` as EventId;
      return {
        occurrence: { ...occurrence, eventId: id, metadata: { raw: large } },
        event: { ...event, eventId: id, payload: { raw: large } },
      };
    });
    await expect(store.recordEvents(group)).rejects.toThrow(
      "transaction exceeds 4 MiB",
    );
    expect(writes).toBe(0);
  });
  it("removes only duplicate event puts after a real-shaped cancellation", async () => {
    let writes = 0,
      saved = row(3);
    const fetcher: typeof fetch = async (_url, init) => {
      const target = new Headers(init?.headers).get("x-amz-target");
      const body = JSON.parse(String(init?.body));
      if (target === "DynamoDB_20120810.GetItem") {
        if (body.Key.PK.S === "META|schema")
          return Response.json({ Item: { projectTimeShards: { N: "4" } } });
        return Response.json({ Item: saved });
      }
      writes++;
      if (writes === 1) {
        expect(body.TransactItems).toHaveLength(3);
        return Response.json(
          {
            __type: "TransactionCanceledException",
            CancellationReasons: [
              {
                Code: "ConditionalCheckFailed",
                Item: { data: { S: JSON.stringify(event) } },
              },
              { Code: "None" },
              { Code: "None" },
            ],
          },
          { status: 400 },
        );
      }
      expect(body.TransactItems).toHaveLength(2);
      expect(
        body.TransactItems[1].Update.ExpressionAttributeValues[":increment"].N,
      ).toBe("1");
      saved = row(4);
      return Response.json({});
    };
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
      fetch: fetcher,
    });
    const nextId = "other" as EventId;
    const result = await store.recordEvents([
      { occurrence, event },
      {
        occurrence: { ...occurrence, eventId: nextId },
        event: { ...event, eventId: nextId },
      },
    ]);
    expect(result.map((r) => r.inserted)).toEqual([false, true]);
    expect(result.map((r) => r.issue.count)).toEqual([4, 4]);
    expect(writes).toBe(2);
  });
  it("re-evaluates grouped regression when an API resolution wins", async () => {
    let writes = 0,
      saved = row(3);
    const fetcher: typeof fetch = async (_url, init) => {
      const target = new Headers(init?.headers).get("x-amz-target");
      const body = JSON.parse(String(init?.body));
      if (target === "DynamoDB_20120810.GetItem") {
        if (body.Key.PK.S === "META|schema")
          return Response.json({ Item: { projectTimeShards: { N: "4" } } });
        return Response.json({ Item: saved });
      }
      writes++;
      if (writes === 1) {
        const resolved = {
          ...issue(3),
          status: "resolved" as const,
          resolvedAt: "2024-12-31T00:00:00.000Z" as Timestamp,
        };
        saved = { ...row(3), ...issueMutableAttributes(resolved) };
        return Response.json(
          {
            __type: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "None" },
              { Code: "ConditionalCheckFailed", Item: saved },
            ],
          },
          { status: 400 },
        );
      }
      expect(body.TransactItems[1].Update.UpdateExpression).toContain(
        "REMOVE #removedResolved",
      );
      saved = row(4);
      return Response.json({});
    };
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
      fetch: fetcher,
    });
    const results = await store.recordEvents([{ occurrence, event }]);
    expect(results[0]).toMatchObject({
      inserted: true,
      isRegression: true,
      issue: { count: 4 },
    });
    expect(writes).toBe(2);
  });
  it("re-evaluates regression when a status update wins between the read and transaction", async () => {
    let saved = row(3),
      writes = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      const target = new Headers(init?.headers).get("x-amz-target");
      const body = JSON.parse(String(init?.body));
      if (target === "DynamoDB_20120810.GetItem") {
        if (body.Key.PK.S === "META|schema")
          return Response.json({ Item: { projectTimeShards: { N: "4" } } });
        return Response.json({ Item: saved });
      }
      const update = body.TransactItems[1].Update;
      if (++writes === 1) {
        const resolved = {
          ...issue(3),
          status: "resolved" as const,
          resolvedAt: "2024-12-31T00:00:00.000Z" as Timestamp,
        };
        saved = { ...row(3), ...issueMutableAttributes(resolved) };
        return Response.json(
          {
            __type: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "None" },
              { Code: "ConditionalCheckFailed", Item: saved },
            ],
          },
          { status: 400 },
        );
      }
      expect(update.ConditionExpression).toContain("#status = :resolved");
      expect(update.UpdateExpression).toContain("REMOVE #removeResolved");
      saved = row(4);
      return Response.json({});
    };
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
      fetch: fetcher,
    });
    await store.migrate();
    expect(await store.recordEvent(occurrence, event)).toMatchObject({
      isRegression: true,
      issue: { status: "unresolved", count: 4 },
    });
    expect(writes).toBe(2);
  });
  it("retries with the returned issue preimage without a reread", async () => {
    let reads = 0,
      writes = 0,
      saved = row(3);
    const tokens: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const target = new Headers(init?.headers).get("x-amz-target"),
        body = JSON.parse(String(init?.body));
      if (target === "DynamoDB_20120810.GetItem") {
        if (body.Key.PK.S === "META|schema")
          return Response.json({ Item: { projectTimeShards: { N: "4" } } });
        reads++;
        return Response.json({ Item: saved });
      }
      if (target !== "DynamoDB_20120810.TransactWriteItems")
        throw new Error("Unexpected request");
      writes++;
      tokens.push(body.ClientRequestToken);
      const update = body.TransactItems[1].Update;
      expect(update.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
      expect(update.ConditionExpression).not.toContain("#oldData");
      expect(update.UpdateExpression).not.toContain("#data");
      if (writes === 1) {
        expect(update.ExpressionAttributeValues[":oldCount"].N).toBe("3");
        saved = row(4);
        return Response.json(
          {
            __type: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "None" },
              { Code: "ConditionalCheckFailed", Item: saved },
            ],
          },
          { status: 400 },
        );
      }
      expect(update.ExpressionAttributeValues[":oldCount"].N).toBe("4");
      saved = row(5);
      return Response.json({});
    };
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
      fetch: fetcher,
    });
    const result = await store.recordEvent(occurrence, event);
    expect(result.issue.count).toBe(5);
    expect(reads).toBe(2);
    expect(writes).toBe(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });
  it("returns the persisted issue after the event conditional rejects a duplicate", async () => {
    let writes = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      const target = new Headers(init?.headers).get("x-amz-target");
      const body = JSON.parse(String(init?.body));
      if (target === "DynamoDB_20120810.GetItem") {
        if (body.Key.PK.S === "META|schema")
          return Response.json({ Item: { projectTimeShards: { N: "4" } } });
        return Response.json({ Item: row(3) });
      }
      writes++;
      return Response.json(
        {
          __type: "TransactionCanceledException",
          CancellationReasons: [
            {
              Code: "ConditionalCheckFailed",
              Item: { data: { S: JSON.stringify(event) } },
            },
            { Code: "None" },
          ],
        },
        { status: 400 },
      );
    };
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
      fetch: fetcher,
    });
    await store.migrate();
    const result = await store.recordEvent(occurrence, event);
    expect(result).toMatchObject({
      inserted: false,
      isNew: false,
      isRegression: false,
      issue: { count: 3 },
    });
    expect(writes).toBe(1);
  });
});
