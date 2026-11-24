import { InvalidCursorError } from "@moriyoshi/errtraq-core/store";
import { describe, expect, it, vi } from "vitest";
import { DynamoStoreError } from "./errors.js";
import { indexCursor } from "./keys.js";
import { contentionDelay, hydrateRows, pageIndex } from "./repository-base.js";

const key = (value: string) => ({ S: value });
const indexRow = (id: string) => ({
  PK: key(id),
  SK: key("DATA"),
  GSI7PK: key("group"),
  GSI7SK: key(id),
});

describe("DynamoDB indexed pagination", () => {
  it("deduplicates primary keys when stale index entries occur in two streams", async () => {
    const request = vi.fn(
      async (_action: string, input: Record<string, unknown>) => {
        const keys = (input.RequestItems as { table: { Keys: unknown[] } })
          .table.Keys;
        expect(keys).toHaveLength(1);
        return { Responses: { table: [indexRow("a")] } };
      },
    );
    const rows = [indexRow("a"), { ...indexRow("a"), GSI7SK: key("old") }];
    expect((await hydrateRows({ table: "table", request }, rows)).size).toBe(1);
  });
  it("uses exponential full jitter with a 500 ms ceiling", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const done = contentionDelay(20);
      await vi.advanceTimersByTimeAsync(249);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await done;
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });
  it("maps a provider rejection of an exclusive start key to InvalidCursorError", async () => {
    const cursor = indexCursor("scope", {
      PK: "a",
      SK: "DATA",
      indexPK: "group",
      indexSK: "bad",
    });
    const request = vi.fn(async () => {
      throw new DynamoStoreError("bad start key", "ValidationException");
    });
    await expect(
      pageIndex(
        { table: "table", request },
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
