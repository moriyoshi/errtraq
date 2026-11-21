import { InvalidCursorError } from "@errtraq/core/store";
import { describe, expect, it, vi } from "vitest";
import { indexCursor } from "./keys.js";
import { pageIndex } from "./repository-base.js";

const key = (value: string) => ({ S: value });
const indexRow = (id: string) => ({
  PK: key(id),
  SK: key("DATA"),
  GSI7PK: key("group"),
  GSI7SK: key(id),
});

describe("DynamoDB indexed pagination", () => {
  it("advances past stale examined entries and hydrates live entries consistently", async () => {
    const first = indexRow("a"),
      second = indexRow("b"),
      third = indexRow("c");
    const request = vi.fn(
      async (action: string, input: Record<string, unknown>) => {
        if (action === "Query") {
          if (!input.ExclusiveStartKey)
            return { Items: [first], LastEvaluatedKey: first };
          return { Items: [second], LastEvaluatedKey: second };
        }
        expect(action).toBe("BatchGetItem");
        expect(input).toMatchObject({
          RequestItems: { table: { ConsistentRead: true } },
        });
        const keys = (input.RequestItems as { table: { Keys: unknown[] } })
          .table.Keys;
        if (JSON.stringify(keys).includes('"a"'))
          return { Responses: { table: [] } };
        return {
          Responses: {
            table: [{ ...second, data: key(JSON.stringify({ id: "b" })) }],
          },
        };
      },
    );
    const page = await pageIndex<{ id: string }>(
      { table: "table", request },
      "entity-list",
      "GSI7PK",
      "GSI7SK",
      "group",
      "scope",
      undefined,
      1,
    );
    expect(page.items).toEqual([{ id: "b" }]);
    expect(page.nextCursor).toBe(
      indexCursor("scope", {
        PK: "b",
        SK: "DATA",
        indexPK: "group",
        indexSK: "b",
      }),
    );
    expect(
      request.mock.calls.filter(([action]) => action === "Query"),
    ).toHaveLength(2);
    expect(page.nextCursor).not.toBe(
      indexCursor("scope", {
        PK: "c",
        SK: "DATA",
        indexPK: "group",
        indexSK: third.GSI7SK.S,
      }),
    );
  });
  it("rejects a valid cursor for a different index partition", async () => {
    const cursor = indexCursor("scope", {
      PK: "a",
      SK: "DATA",
      indexPK: "other",
      indexSK: "a",
    });
    await expect(
      pageIndex(
        { table: "table", request: vi.fn() },
        "entity-list",
        "GSI7PK",
        "GSI7SK",
        "group",
        "scope",
        cursor,
        1,
      ),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });
});
