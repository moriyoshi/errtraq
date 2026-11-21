import type { EventId, ProjectId } from "@errtraq/core";
import { describe, expect, it, vi } from "vitest";
import { eventRepository } from "./events.js";
import { eventTimeSort, partition } from "./keys.js";
import { type Driver, primary, s } from "./repository-base.js";

describe("DynamoDB event repository", () => {
  it("prefetches and hydrates pages over 100 in bounded batches", async () => {
    const projectId = "project" as ProjectId;
    const issueId = "issue" as import("@errtraq/core").IssueId;
    const time = "2025-01-01T00:00:00.000Z";
    const rows = Array.from({ length: 130 }, (_, i) => {
      const id = String(i).padStart(3, "0");
      return {
        ...primary(id),
        GSI2PK: s(partition("EVENTISSUE", projectId, issueId)),
        GSI2SK: s(eventTimeSort(time, id)),
        data: s(
          JSON.stringify({ projectId, issueId, eventId: id, receivedAt: time }),
        ),
      };
    });
    const counts: Record<string, number> = {};
    const request: Driver["request"] = async (action, input) => {
      counts[action] = (counts[action] ?? 0) + 1;
      if (action === "Query") {
        const start = (
          input.ExclusiveStartKey as { PK?: { S?: string } } | undefined
        )?.PK?.S;
        const offset = start
          ? rows.findIndex((row) => row.PK.S === start) + 1
          : 0;
        const items = rows.slice(offset, offset + Number(input.Limit));
        return {
          Items: items,
          ...(offset + items.length < rows.length
            ? { LastEvaluatedKey: items.at(-1) }
            : {}),
        };
      }
      const keys = (
        input.RequestItems as { table: { Keys: { PK: { S: string } }[] } }
      ).table.Keys;
      expect(keys.length).toBeLessThanOrEqual(100);
      return {
        Responses: {
          table: rows.filter((row) =>
            keys.some((key) => key.PK.S === row.PK.S),
          ),
        },
      };
    };
    const result = await eventRepository(
      { table: "table", request },
      () => 4,
    ).listByIssue({ projectId, issueId, order: "asc", limit: 130 });
    expect(result.items).toHaveLength(130);
    expect(result.nextCursor).toBeNull();
    expect(counts).toEqual({ Query: 2, BatchGetItem: 2 });
  });
  it("advances the examined cursor over stale candidates without skipping live events", async () => {
    const projectId = "project" as ProjectId;
    const issueId = "issue" as import("@errtraq/core").IssueId;
    const time =
      "2025-01-01T00:00:00.000Z" as import("@errtraq/core").Timestamp;
    const hash = partition("EVENTISSUE", projectId, issueId);
    const rows = ["a", "b", "c"].map((id) => ({
      ...primary(id),
      GSI2PK: s(hash),
      GSI2SK: s(eventTimeSort(time, id)),
      data: s(
        JSON.stringify({
          projectId,
          issueId,
          eventId: id,
          timestamp: time,
          receivedAt: time,
          level: "error",
          tags: {},
          payload: {},
        }),
      ),
    }));
    const request: Driver["request"] = async (action, input) => {
      if (action === "Query") {
        const start = (
          input.ExclusiveStartKey as { PK?: { S?: string } } | undefined
        )?.PK?.S;
        const index = start
          ? rows.findIndex((row) => row.PK.S === start) + 1
          : 0;
        const items = rows.slice(index, index + Number(input.Limit));
        return {
          Items: items,
          ...(index + items.length < rows.length
            ? { LastEvaluatedKey: items.at(-1) }
            : {}),
        };
      }
      const keys = (
        input.RequestItems as { table: { Keys: { PK: { S: string } }[] } }
      ).table.Keys;
      const id = keys[0]?.PK.S;
      return {
        Responses: {
          table: rows.filter((row) => row.PK.S === id && id !== "a"),
        },
      };
    };
    const repo = eventRepository({ table: "table", request }, () => 4);
    const first = await repo.listByIssue({
      projectId,
      issueId,
      order: "asc",
      limit: 1,
    });
    expect(first.items.map((event) => event.eventId)).toEqual(["b"]);
    const second = await repo.listByIssue({
      projectId,
      issueId,
      order: "asc",
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((event) => event.eventId)).toEqual(["c"]);
  });
  it("reads the exact event key with one strongly consistent read", async () => {
    const request = vi.fn(async () => ({}));
    const repo = eventRepository({ table: "table", request }, () => 4);
    expect(
      await repo.get("project" as ProjectId, "event" as EventId),
    ).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "GetItem",
      expect.objectContaining({
        ConsistentRead: true,
        Key: expect.objectContaining({
          PK: expect.objectContaining({ S: expect.stringMatching(/^EV\|/) }),
        }),
      }),
    );
  });
  it("chunks deletes at 25 and retries only unprocessed keys", async () => {
    const batches: number[] = [];
    const request: Driver["request"] = async (action, input) => {
      expect(action).toBe("BatchWriteItem");
      const requests = input.RequestItems as Record<string, unknown[]>;
      const batch = requests.table ?? [];
      batches.push(batch.length);
      return batches.length === 1
        ? { UnprocessedItems: { table: [batch[0]] } }
        : {};
    };
    const repo = eventRepository({ table: "table", request }, () => 4);
    await repo.deleteBatch(
      "project" as ProjectId,
      Array.from({ length: 26 }, (_, i) => `id-${i}` as EventId),
    );
    expect(batches).toEqual([25, 1, 1]);
  });
});
