import type {
  EventId,
  Issue,
  IssueId,
  Occurrence,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "@errtraq/core";
import { describe, expect, it } from "vitest";
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
});
describe("DynamoDB recordEvent", () => {
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
      saved = {
        data: update.ExpressionAttributeValues[":data"],
        count: { N: "5" },
      };
      return Response.json({});
    };
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
      fetch: fetcher,
    });
    await store.migrate();
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
