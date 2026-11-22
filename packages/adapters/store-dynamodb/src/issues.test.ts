import type { Issue, IssueQuery, ProjectId } from "@errtraq/core";
import { describe, expect, it } from "vitest";
import { issueRepository } from "./issues.js";
import { issueAttributes } from "./record-event.js";
import { type Driver, type Item, primary, s } from "./repository-base.js";

const projectId = "project" as ProjectId;
describe("DynamoDB issue index pagination", () => {
  it("reads an issue using a strongly consistent base-table get", async () => {
    const calls: unknown[] = [];
    const request: Driver["request"] = async (action, input) => {
      calls.push({ action, input });
      return {};
    };
    expect(
      await issueRepository({ table: "table", request }).get(
        projectId,
        "issue" as Issue["id"],
      ),
    ).toBeNull();
    expect(calls).toEqual([
      expect.objectContaining({
        action: "GetItem",
        input: expect.objectContaining({
          TableName: "table",
          ConsistentRead: true,
        }),
      }),
    ]);
  });
  it.each([25, 130])(
    "hydrates %i issues in bounded batches rather than one request per row",
    async (size) => {
      const rows: Item[] = Array.from({ length: size }, (_, i) => {
        const id = String(i).padStart(2, "0");
        const time = "2025-01-01T00:00:00.000Z" as Issue["lastSeen"];
        const issue: Issue = {
          id: id as Issue["id"],
          projectId,
          fingerprint: id,
          status: "unresolved",
          title: "t",
          culprit: "",
          level: "error",
          type: "error",
          metadata: {},
          firstSeen: time,
          lastSeen: time,
          count: 1,
          lastEventId: "event" as Issue["lastEventId"],
          lastEventReceivedAt: time,
        };
        return {
          ...primary(id),
          ...issueAttributes(issue),
          data: s(JSON.stringify(issue)),
        };
      });
      const counts: Record<string, number> = {};
      const request: Driver["request"] = async (action, input) => {
        counts[action] = (counts[action] ?? 0) + 1;
        if (action === "Query") {
          const hash = (
            input.ExpressionAttributeValues as Record<string, { S: string }>
          )[":hash"]?.S;
          const candidates = hash === rows[0]?.GSI4PK?.S ? rows : [];
          const start = (input.ExclusiveStartKey as Item | undefined)?.PK?.S;
          const offset = start
            ? candidates.findIndex((row) => row.PK?.S === start) + 1
            : 0;
          const items = candidates.slice(offset, offset + Number(input.Limit));
          return {
            Items: items,
            ...(offset + items.length < candidates.length
              ? { LastEvaluatedKey: items.at(-1) }
              : {}),
          };
        }
        const keys = (
          input.RequestItems as { table: { Keys: { PK: { S: string } }[] } }
        ).table.Keys;
        return {
          Responses: {
            table: rows.filter((row) =>
              keys.some((key) => key.PK.S === row.PK?.S),
            ),
          },
        };
      };
      const page = await issueRepository({ table: "table", request }).list({
        projectId,
        sort: "lastSeen",
        limit: size,
      });
      expect(page.items).toHaveLength(size);
      expect(counts).toEqual({
        Query: size === 25 ? 3 : 4,
        BatchGetItem: size === 25 ? 1 : 2,
      });
    },
  );
  it("advances over stale entries without advancing a prefetched status stream", async () => {
    const issue = (
      id: string,
      status: Issue["status"],
      lastSeen: string,
    ): Issue => ({
      id: id as Issue["id"],
      projectId,
      fingerprint: id,
      status,
      title: "t",
      culprit: "",
      level: "error",
      type: "error",
      metadata: {},
      firstSeen: lastSeen as Issue["firstSeen"],
      lastSeen: lastSeen as Issue["lastSeen"],
      count: 1,
      lastEventId: "event" as Issue["lastEventId"],
      lastEventReceivedAt: lastSeen as Issue["lastEventReceivedAt"],
    });
    const first = issue("a", "unresolved", "2025-01-03T00:00:00.000Z"),
      second = issue("b", "resolved", "2025-01-02T00:00:00.000Z");
    const item = (x: Issue): Item => ({
      ...primary(x.id),
      ...issueAttributes(x),
      data: s(JSON.stringify(x)),
    });
    const stale = { ...item(first), PK: s("stale") },
      live = item(first),
      other = item(second);
    const byId: Record<string, Item> = { a: live, b: other };
    const driver: Driver = {
      table: "table",
      async request(action, input) {
        if (action === "Query") {
          const hash = (
            input.ExpressionAttributeValues as Record<string, { S: string }>
          )[":hash"]?.S;
          const start = (input.ExclusiveStartKey as Item | undefined)?.PK?.S;
          const rows =
            hash === live.GSI4PK?.S
              ? [stale, live]
              : hash === other.GSI4PK?.S
                ? [other]
                : [];
          const index = start ? rows.findIndex((x) => x.PK.S === start) + 1 : 0;
          const items = rows.slice(index, index + Number(input.Limit));
          return {
            Items: items,
            ...(index + items.length < rows.length
              ? { LastEvaluatedKey: items.at(-1) }
              : {}),
          };
        }
        if (action === "BatchGetItem") {
          const requests = input.RequestItems as {
            table: { Keys: { PK: { S: string } }[]; ConsistentRead: boolean };
          };
          expect(requests.table.ConsistentRead).toBe(true);
          const items = requests.table.Keys.map((key) => byId[key.PK.S]).filter(
            Boolean,
          );
          return { Responses: { table: items } };
        }
        throw new Error(`Unexpected ${action}`);
      },
    };
    const repo = issueRepository(driver),
      query: IssueQuery = { projectId, sort: "lastSeen", limit: 1 };
    const page1 = await repo.list(query);
    expect(page1.items.map((x) => x.id)).toEqual(["a"]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await repo.list({
      ...query,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items.map((x) => x.id)).toEqual(["b"]);
  });
});
