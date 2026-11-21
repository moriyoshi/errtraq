import type { EventQuery, EventRepo, Page, StoredEvent } from "@errtraq/core";
import {
  decodeCursor,
  encodeCursor,
  eventCursorScope,
  InvalidCursorError,
  pageLimit,
  UnsupportedQueryError,
} from "@errtraq/core/store";
import { DynamoStoreError } from "./errors.js";
import { eventTimeSort, partition } from "./keys.js";
import { eventKey } from "./record-event.js";
import {
  type Driver,
  get,
  type Item,
  itemData,
  primary,
  s,
} from "./repository-base.js";

type Stream = { hash: string; done: boolean; start?: Item; next?: Item };
async function list(
  d: Driver,
  shards: number,
  query: EventQuery,
  scope: string,
): Promise<Page<StoredEvent>> {
  const limit = pageLimit(query.limit),
    order = query.order ?? "desc";
  if (!Number.isInteger(shards) || shards < 1 || shards > 4)
    throw new DynamoStoreError(
      "DynamoDB store must be migrated before querying events",
    );
  const index = query.issueId ? "event-issue-time" : "event-project-time",
    n = query.issueId ? 2 : 1,
    hash = `GSI${n}PK`,
    range = `GSI${n}SK`;
  const hashes = query.issueId
    ? [partition("EVENTISSUE", query.projectId, query.issueId)]
    : Array.from({ length: shards }, (_, i) =>
        partition("EVENTPROJECT", query.projectId, String(i)),
      );
  const decoded = decodeCursor(query.cursor, scope);
  if (
    decoded &&
    (decoded.length !== hashes.length + 1 ||
      decoded.some((x) => typeof x !== "string"))
  )
    throw new InvalidCursorError("Invalid event cursor");
  const streams: Stream[] = hashes.map((value, i) => {
    const raw = decoded?.[i];
    if (raw === "done") return { hash: value, done: true };
    if (!raw) return { hash: value, done: false };
    try {
      const tuple: unknown = JSON.parse(String(raw));
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 4 ||
        tuple.some((x) => typeof x !== "string" || !x) ||
        tuple[2] !== value
      )
        throw new Error();
      const [PK, SK, indexPK, indexSK] = tuple;
      return {
        hash: value,
        done: false,
        start: {
          PK: s(PK),
          SK: s(SK),
          [hash]: s(indexPK),
          [range]: s(indexSK),
        },
      };
    } catch {
      throw new InvalidCursorError("Invalid event cursor");
    }
  });
  if (query.from && query.to && query.from >= query.to)
    return { items: [], nextCursor: null };
  let lower = query.from
    ? `${eventTimeSort(query.from, "x").slice(0, 24)}#`
    : undefined;
  let upper = query.to
    ? `${eventTimeSort(query.to, "x").slice(0, 24)}#`
    : undefined;
  const explicitAfter = query.after
    ? eventTimeSort(query.after.receivedAt, query.after.eventId)
    : undefined;
  let boundary = decoded?.[hashes.length] as string | undefined;
  if (
    boundary &&
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z#[0-9a-f]+!$/.test(boundary)
  )
    throw new InvalidCursorError("Invalid event boundary");
  const after =
    explicitAfter && boundary
      ? order === "asc"
        ? explicitAfter > boundary
          ? explicitAfter
          : boundary
        : explicitAfter < boundary
          ? explicitAfter
          : boundary
      : (explicitAfter ?? boundary);
  if (after && order === "asc" && (!lower || after > lower)) lower = after;
  if (after && order === "desc" && (!upper || after < upper)) upper = after;
  if (lower && upper && lower >= upper) return { items: [], nextCursor: null };
  const items: StoredEvent[] = [];
  let examined = 0;
  while (items.length < limit && examined < 100) {
    for (const stream of streams) {
      if (stream.done || stream.next) continue;
      const response = await d.request("Query", {
        TableName: d.table,
        IndexName: index,
        ScanIndexForward: order === "asc",
        KeyConditionExpression: `#hash = :hash${lower && upper ? " AND #range BETWEEN :lower AND :upper" : lower ? " AND #range >= :lower" : upper ? " AND #range <= :upper" : ""}`,
        ExpressionAttributeNames: {
          "#hash": hash,
          ...(lower || upper ? { "#range": range } : {}),
        },
        ExpressionAttributeValues: {
          ":hash": s(stream.hash),
          ...(lower ? { ":lower": s(lower) } : {}),
          ...(upper ? { ":upper": s(upper) } : {}),
        },
        Limit: 1,
        ...(stream.start ? { ExclusiveStartKey: stream.start } : {}),
      });
      stream.next = (response.Items as Item[] | undefined)?.[0];
      if (!stream.next) stream.done = true;
    }
    const available = streams
      .filter((x) => x.next)
      .sort((a, b) => {
        const x = a.next?.[range]?.S ?? "",
          y = b.next?.[range]?.S ?? "";
        return (x < y ? -1 : x > y ? 1 : 0) * (order === "asc" ? 1 : -1);
      });
    const selected = available[0];
    if (!selected?.next) break;
    const row = selected.next;
    selected.next = undefined;
    selected.start = row;
    examined++;
    const key = row[range]?.S;
    if (!key || (after && (order === "asc" ? key <= after : key >= after)))
      continue;
    boundary = key;
    let keys = [{ PK: row.PK, SK: row.SK }],
      full: Item | undefined;
    for (let attempt = 0; keys.length && attempt < 10; attempt++) {
      const response = await d.request("BatchGetItem", {
        RequestItems: { [d.table]: { Keys: keys, ConsistentRead: true } },
      });
      const values = response.Responses as Record<string, Item[]> | undefined;
      full ??= values?.[d.table]?.[0];
      const pending = response.UnprocessedKeys as
        | Record<string, { Keys?: typeof keys }>
        | undefined;
      keys = pending?.[d.table]?.Keys ?? [];
      if (keys.length)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * Math.min(250, 10 * 2 ** attempt)),
        );
    }
    if (keys.length)
      throw new DynamoStoreError(
        "Unprocessed event hydration",
        undefined,
        true,
      );
    const event = itemData<StoredEvent>(full);
    if (
      event &&
      event.projectId === query.projectId &&
      (!query.issueId || event.issueId === query.issueId) &&
      full?.[hash]?.S === row[hash]?.S &&
      full?.[range]?.S === key &&
      (!query.from || event.receivedAt >= query.from) &&
      (!query.to || event.receivedAt < query.to)
    )
      items.push(event);
  }
  const nextCursor = streams.every((x) => x.done)
    ? null
    : encodeCursor(scope, [
        ...streams.map((stream) =>
          stream.done
            ? "done"
            : !stream.start
              ? ""
              : JSON.stringify([
                  stream.start.PK?.S,
                  stream.start.SK?.S,
                  stream.start[hash]?.S,
                  stream.start[range]?.S,
                ]),
        ),
        boundary ?? "",
      ]);
  return { items, nextCursor };
}
export function eventRepository(
  d: Driver,
  shards: () => number | undefined,
): EventRepo {
  return {
    capabilities: { deleteStrategy: "explicit", deleteBySubject: false },
    get: async (project, id) =>
      itemData<StoredEvent>(await get(d, eventKey(project, id))),
    listByIssue: async (query) => {
      const page = await list(d, shards() ?? 0, query, eventCursorScope(query));
      return { ...page, hasMore: page.nextCursor !== null };
    },
    scanOlderThan: (project, cutoff, options) => {
      const query: EventQuery = {
        projectId: project,
        to: cutoff,
        order: "asc",
        cursor: options?.cursor,
        limit: options?.limit,
      };
      return list(
        d,
        shards() ?? 0,
        query,
        JSON.stringify(["scanOlderThan", project, cutoff, shards()]),
      );
    },
    deleteBatch: async (project, ids) => {
      const unique = [...new Set(ids)];
      for (let offset = 0; offset < unique.length; offset += 25) {
        let writes = unique.slice(offset, offset + 25).map((id) => ({
          DeleteRequest: { Key: primary(eventKey(project, id)) },
        }));
        for (let attempt = 0; writes.length && attempt < 10; attempt++) {
          const response = await d.request("BatchWriteItem", {
            RequestItems: { [d.table]: writes },
          });
          const pending = response.UnprocessedItems as
            | Record<string, typeof writes>
            | undefined;
          writes = pending?.[d.table] ?? [];
          if (writes.length)
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.random() * Math.min(250, 10 * 2 ** attempt),
              ),
            );
        }
        if (writes.length)
          throw new DynamoStoreError(
            "Unprocessed event deletions",
            undefined,
            true,
          );
      }
    },
    deleteBySubject: async () => {
      throw new UnsupportedQueryError(
        "Subject erasure is unavailable until M4",
      );
    },
  };
}
