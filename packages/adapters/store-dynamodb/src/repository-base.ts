import type { Cursor, Page } from "@errtraq/core";
import {
  ConflictError,
  InvalidCursorError,
  pageLimit,
} from "@errtraq/core/store";
import { DynamoStoreError } from "./errors.js";
import { indexCursor, readIndexCursor } from "./keys.js";

type Value = Record<string, unknown>;
export interface Driver {
  readonly table: string;
  request(action: string, input: Value): Promise<Value>;
}
export type Item = Record<string, { S?: string; N?: string }>;
export const s = (value: string) => ({ S: value });
export const primary = (PK: string, SK = "DATA") => ({ PK: s(PK), SK: s(SK) });
/** Reject oversized string/number-only table items before submitting a transaction. */
export function assertItemSize(item: Item): void {
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const [name, value] of Object.entries(item)) {
    bytes += encoder.encode(name).length;
    if (value.S !== undefined) bytes += encoder.encode(value.S).length;
    else if (value.N !== undefined) bytes += encoder.encode(value.N).length;
    else throw new TypeError("Unsupported DynamoDB item attribute");
  }
  if (bytes > 400 * 1024) throw new RangeError("DynamoDB item exceeds 400 KiB");
}
export function itemData<T>(item: Item | undefined): T | null {
  if (!item) return null;
  if (typeof item.data?.S !== "string")
    throw new DynamoStoreError("Invalid DynamoDB store item");
  try {
    return JSON.parse(item.data.S) as T;
  } catch {
    throw new DynamoStoreError("Invalid DynamoDB store item");
  }
}
export async function get(
  driver: Driver,
  PK: string,
  SK = "DATA",
): Promise<Item | undefined> {
  const result = await driver.request("GetItem", {
    TableName: driver.table,
    Key: primary(PK, SK),
    ConsistentRead: true,
  });
  return result.Item as Item | undefined;
}
export function dataItem<T>(
  PK: string,
  value: T,
  index?: { partition: string; sort: string },
): Item {
  return {
    ...primary(PK),
    data: s(JSON.stringify(value)),
    revision: s(crypto.randomUUID()),
    ...(index ? { GSI7PK: s(index.partition), GSI7SK: s(index.sort) } : {}),
  };
}
export function conditionFor(item: Item | undefined) {
  return item
    ? {
        ConditionExpression: "#rev = :rev",
        ExpressionAttributeNames: { "#rev": "revision" },
        ExpressionAttributeValues: { ":rev": item.revision },
      }
    : { ConditionExpression: "attribute_not_exists(PK)" };
}
export function cancelled(error: unknown): boolean {
  return (
    error instanceof DynamoStoreError &&
    error.providerCode === "TransactionCanceledException" &&
    !error.ambiguous
  );
}
export function conflict(): never {
  throw new ConflictError("Natural key already exists");
}

/** Full jitter spreads contending writers over a window capped at 500 ms. */
export async function contentionDelay(attempt: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.random() * Math.min(500, 2 ** Math.min(attempt, 9)),
    ),
  );
}

/** Strongly hydrate index rows in DynamoDB's maximum batch size. */
export async function hydrateRows(
  driver: Driver,
  rows: Item[],
): Promise<Map<string, Item>> {
  const hydrated = new Map<string, Item>();
  const unique = [
    ...new Map(
      rows.map((row) => [JSON.stringify([row.PK?.S, row.SK?.S]), row]),
    ).values(),
  ];
  for (let offset = 0; offset < unique.length; offset += 100) {
    let keys = unique
      .slice(offset, offset + 100)
      .map(({ PK, SK }) => ({ PK, SK }));
    for (let attempt = 0; keys.length && attempt < 10; attempt++) {
      const result = await driver.request("BatchGetItem", {
        RequestItems: { [driver.table]: { Keys: keys, ConsistentRead: true } },
      });
      const values = result.Responses as Record<string, Item[]> | undefined;
      for (const item of values?.[driver.table] ?? [])
        hydrated.set(JSON.stringify([item.PK?.S, item.SK?.S]), item);
      const pending = result.UnprocessedKeys as
        | Record<string, { Keys?: typeof keys }>
        | undefined;
      keys = pending?.[driver.table]?.Keys ?? [];
      if (keys.length)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * Math.min(250, 10 * 2 ** attempt)),
        );
    }
    if (keys.length)
      throw new DynamoStoreError(
        "DynamoDB did not process index hydration",
        undefined,
        true,
      );
  }
  return hydrated;
}

/** DynamoDB rejects some syntactically valid but tampered exclusive start keys. */
export async function queryIndex(
  driver: Driver,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    return await driver.request("Query", input);
  } catch (error) {
    if (
      input.ExclusiveStartKey &&
      error instanceof DynamoStoreError &&
      error.providerCode === "ValidationException"
    )
      throw new InvalidCursorError("Invalid DynamoDB index cursor");
    throw error;
  }
}

/** Query a sparse GSI, strongly hydrate candidates and advance only over examined keys. */
export async function pageIndex<T>(
  driver: Driver,
  index: string,
  hashAttribute: string,
  rangeAttribute: string,
  hash: string,
  scope: string,
  cursor?: Cursor,
  limit?: number,
  upper?: string,
): Promise<Page<T>> {
  const size = pageLimit(limit),
    position = readIndexCursor(scope, cursor);
  let start: Item | undefined = position
    ? {
        PK: s(position.PK),
        SK: s(position.SK),
        [hashAttribute]: s(position.indexPK),
        [rangeAttribute]: s(position.indexSK),
      }
    : undefined;
  if (position && position.indexPK !== hash)
    throw new InvalidCursorError("Cursor does not match index partition");
  const items: T[] = [];
  for (let batch = 0; batch < 32; batch++) {
    const result = await queryIndex(driver, {
      TableName: driver.table,
      IndexName: index,
      KeyConditionExpression: `#pk = :pk${upper ? " AND #sk <= :upper" : ""}`,
      ExpressionAttributeNames: {
        "#pk": hashAttribute,
        ...(upper ? { "#sk": rangeAttribute } : {}),
      },
      ExpressionAttributeValues: {
        ":pk": s(hash),
        ...(upper ? { ":upper": s(upper) } : {}),
      },
      Limit: Math.min(100, size - items.length),
      ...(start ? { ExclusiveStartKey: start } : {}),
    });
    const rows = (result.Items ?? []) as Item[];
    let keys = rows.map((row) => ({ PK: row.PK, SK: row.SK }));
    const hydrated = new Map<string, Item>();
    for (let attempt = 0; keys.length && attempt < 10; attempt++) {
      const response = await driver.request("BatchGetItem", {
        RequestItems: { [driver.table]: { Keys: keys, ConsistentRead: true } },
      });
      const output = response.Responses as Record<string, Item[]> | undefined;
      for (const item of output?.[driver.table] ?? [])
        hydrated.set(JSON.stringify([item.PK?.S, item.SK?.S]), item);
      const pending = response.UnprocessedKeys as
        | Record<string, { Keys?: typeof keys }>
        | undefined;
      keys = pending?.[driver.table]?.Keys ?? [];
      if (keys.length && attempt < 9)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * Math.min(250, 10 * 2 ** attempt)),
        );
    }
    if (keys.length)
      throw new DynamoStoreError(
        "DynamoDB did not process index hydration",
        undefined,
        true,
      );
    for (const row of rows) {
      const full = hydrated.get(JSON.stringify([row.PK?.S, row.SK?.S]));
      if (
        full &&
        full[hashAttribute]?.S === hash &&
        full[rangeAttribute]?.S === row[rangeAttribute]?.S
      ) {
        const value = itemData<T>(full);
        if (value !== null) items.push(value);
      }
    }
    start = result.LastEvaluatedKey as Item | undefined;
    if (!start) return { items, nextCursor: null };
    const PK = start.PK?.S,
      SK = start.SK?.S,
      indexPK = start[hashAttribute]?.S,
      indexSK = start[rangeAttribute]?.S;
    if (!PK || !SK || !indexPK || !indexSK)
      throw new DynamoStoreError("Invalid DynamoDB index continuation");
    if (items.length >= size || batch === 31)
      return {
        items,
        nextCursor: indexCursor(scope, { PK, SK, indexPK, indexSK }),
      };
  }
  return { items, nextCursor: null };
}
