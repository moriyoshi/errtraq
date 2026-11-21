import type { Issue, IssueQuery, ProjectId } from "@errtraq/core";
import { describe, expect, it } from "vitest";
import { issueRepository } from "./issues.js";
import { issueAttributes } from "./record-event.js";
import { type Driver, type Item, primary, s } from "./repository-base.js";

const projectId = "project" as ProjectId;
describe("DynamoDB issue index pagination", () => {
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
          return { Items: rows.slice(index, index + 1) };
        }
        if (action === "BatchGetItem") {
          const requests = input.RequestItems as {
            table: { Keys: { PK: { S: string } }[]; ConsistentRead: boolean };
          };
          expect(requests.table.ConsistentRead).toBe(true);
          const item = byId[requests.table.Keys[0]?.PK.S ?? ""];
          return { Responses: { table: item ? [item] : [] } };
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
