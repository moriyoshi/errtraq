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
      // No counter exists yet: the facet pre-read finds nothing.
      if (target === "DynamoDB_20120810.BatchGetItem")
        return Response.json({ Responses: { table: [] } });
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
  it("fits the widest group in one transaction: 88 actions for ten events on ten days", async () => {
    const transactions: Array<{
      TransactItems: Array<Record<string, unknown>>;
    }> = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const target = new Headers(init?.headers).get("x-amz-target");
      const body = JSON.parse(String(init?.body));
      if (target === "DynamoDB_20120810.BatchGetItem")
        return Response.json({ Responses: { table: [] } });
      if (target === "DynamoDB_20120810.GetItem")
        return Response.json(
          body.Key.PK.S === "META|schema"
            ? { Item: { projectTimeShards: { N: "4" } } }
            : { Item: transactions.length ? row(10) : undefined },
        );
      transactions.push(body);
      return Response.json({});
    };
    const store = new DynamoStore({
      table: "table",
      region: "us-east-1",
      environment: { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
      fetch: fetcher,
    });
    const group = Array.from({ length: 10 }, (_, index) => {
      const id = `wide-${index}` as EventId;
      const at = new Date(
        Date.UTC(2025, 0, 1 + index),
      ).toISOString() as Timestamp;
      return {
        occurrence: {
          ...occurrence,
          eventId: id,
          receivedAt: at,
          timestamp: at,
        },
        event: {
          ...event,
          eventId: id,
          receivedAt: at,
          timestamp: at,
          level: (["fatal", "error", "warning", "info", "debug"] as const)[
            index % 5
          ] as StoredEvent["level"],
          environment: `env-${index}`,
          release: `rel-${index}`,
          tags: {
            server_name: `srv-${index}`,
            "browser.name": `br-${index}`,
            "os.name": `os-${index}`,
            "runtime.name": `rt-${index}`,
          },
        },
      };
    });
    await store.recordEvents(group);
    const [tx] = transactions;
    // 10 events + issue + pointer + 10 day items + 65 values (5 levels, 6 keys x 10) + totals.
    const kinds = (tx?.TransactItems ?? []).map((item) => {
      const op = Object.keys(item)[0] as string;
      const key = item[op] as {
        Key?: { PK: { S: string } };
        Item?: { PK: { S: string } };
      };
      return `${op}${(key.Key?.PK.S ?? key.Item?.PK.S ?? "").slice(0, 3)}`;
    });
    const count = (prefix: string) =>
      kinds.filter((k) => k.endsWith(prefix)).length;
    expect(count("EV|")).toBe(10);
    expect(count("HB|")).toBe(10);
    expect(count("FV|")).toBe(65);
    expect(count("FT|")).toBe(1);
    expect(tx?.TransactItems).toHaveLength(10 + 1 + 1 + 10 + 65 + 1);
    expect(tx?.TransactItems.length).toBeLessThanOrEqual(100);
  });
  it("removes only duplicate event puts after a real-shaped cancellation", async () => {
    let writes = 0,
      saved = row(3);
    const fetcher: typeof fetch = async (_url, init) => {
      const target = new Headers(init?.headers).get("x-amz-target");
      const body = JSON.parse(String(init?.body));
      // No counter exists yet: the facet pre-read finds nothing.
      if (target === "DynamoDB_20120810.BatchGetItem")
        return Response.json({ Responses: { table: [] } });
      if (target === "DynamoDB_20120810.GetItem") {
        if (body.Key.PK.S === "META|schema")
          return Response.json({ Item: { projectTimeShards: { N: "4" } } });
        return Response.json({ Item: saved });
      }
      writes++;
      if (writes === 1) {
        // 2 events + issue + counters (one day item, the level value, the totals item).
        expect(body.TransactItems).toHaveLength(6);
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
      expect(body.TransactItems).toHaveLength(5);
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
      // No counter exists yet: the facet pre-read finds nothing.
      if (target === "DynamoDB_20120810.BatchGetItem")
        return Response.json({ Responses: { table: [] } });
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
      // No counter exists yet: the facet pre-read finds nothing.
      if (target === "DynamoDB_20120810.BatchGetItem")
        return Response.json({ Responses: { table: [] } });
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
      // The facet pre-read is a batch read, not an issue reread.
      if (target === "DynamoDB_20120810.BatchGetItem")
        return Response.json({ Responses: { table: [] } });
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
      // No counter exists yet: the facet pre-read finds nothing.
      if (target === "DynamoDB_20120810.BatchGetItem")
        return Response.json({ Responses: { table: [] } });
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
