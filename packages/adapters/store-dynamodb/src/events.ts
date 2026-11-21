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
  hydrateRows,
  type Item,
  itemData,
  primary,
  queryIndex,
  s,
} from "./repository-base.js";

type Stream = {
  hash: string;
  done: boolean;
  start?: Item;
  buffer?: Item[];
  terminal?: boolean;
};
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
  if (explicitAfter && order === "asc" && (!lower || explicitAfter > lower))
    lower = explicitAfter;
  if (explicitAfter && order === "desc" && (!upper || explicitAfter < upper))
    upper = explicitAfter;
  if (lower && upper && lower >= upper) return { items: [], nextCursor: null };
  const items: StoredEvent[] = [];
  const hydrated = new Map<string, Item>();
  while (items.length < limit) {
    const fetched: Item[] = [];
    for (const stream of streams) {
      if (stream.done || stream.buffer?.length) continue;
      if (stream.terminal) {
        stream.done = true;
        continue;
      }
      let streamLower = lower,
        streamUpper = upper;
      if (
        !stream.start &&
        boundary &&
        order === "asc" &&
        (!streamLower || boundary > streamLower)
      )
        streamLower = boundary;
      if (
        !stream.start &&
        boundary &&
        order === "desc" &&
        (!streamUpper || boundary < streamUpper)
      )
        streamUpper = boundary;
      if (streamLower && streamUpper && streamLower >= streamUpper) {
        stream.done = true;
        continue;
      }
      const response = await queryIndex(d, {
        TableName: d.table,
        IndexName: index,
        ScanIndexForward: order === "asc",
        KeyConditionExpression: `#hash = :hash${streamLower && streamUpper ? " AND #range BETWEEN :lower AND :upper" : streamLower ? " AND #range >= :lower" : streamUpper ? " AND #range <= :upper" : ""}`,
        ExpressionAttributeNames: {
          "#hash": hash,
          ...(streamLower || streamUpper ? { "#range": range } : {}),
        },
        ExpressionAttributeValues: {
          ":hash": s(stream.hash),
          ...(streamLower ? { ":lower": s(streamLower) } : {}),
          ...(streamUpper ? { ":upper": s(streamUpper) } : {}),
        },
        Limit: Math.min(100, limit - items.length),
        ...(stream.start ? { ExclusiveStartKey: stream.start } : {}),
      });
      stream.buffer = (response.Items as Item[] | undefined) ?? [];
      stream.terminal = !response.LastEvaluatedKey;
      if (!stream.buffer.length) {
        stream.done = true;
        continue;
      }
      fetched.push(...stream.buffer);
    }
    for (const [key, value] of await hydrateRows(d, fetched))
      hydrated.set(key, value);
    const available = streams
      .filter((x) => x.buffer?.length)
      .sort((a, b) => {
        const x = a.buffer?.[0]?.[range]?.S ?? "",
          y = b.buffer?.[0]?.[range]?.S ?? "";
        return (x < y ? -1 : x > y ? 1 : 0) * (order === "asc" ? 1 : -1);
      });
    const selected = available[0];
    if (!selected?.buffer?.length) break;
    const row = selected.buffer.shift() as Item;
    selected.start = row;
    if (!selected.buffer.length && selected.terminal) selected.done = true;
    const key = row[range]?.S;
    const hydrationKey = JSON.stringify([row.PK?.S, row.SK?.S]);
    const full = hydrated.get(hydrationKey);
    if (
      !streams.some((stream) =>
        stream.buffer?.some(
          (entry) => entry.PK?.S === row.PK?.S && entry.SK?.S === row.SK?.S,
        ),
      )
    )
      hydrated.delete(hydrationKey);
    if (!key || (after && (order === "asc" ? key <= after : key >= after)))
      continue;
    boundary = key;
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
  shards: () => number | Promise<number>,
): EventRepo {
  return {
    capabilities: { deleteStrategy: "explicit", deleteBySubject: false },
    get: async (project, id) =>
      itemData<StoredEvent>(await get(d, eventKey(project, id))),
    listByIssue: async (query) => {
      const page = await list(
        d,
        await shards(),
        query,
        eventCursorScope(query),
      );
      return { ...page, hasMore: page.nextCursor !== null };
    },
    scanOlderThan: async (project, cutoff, options) => {
      const count = await shards();
      const query: EventQuery = {
        projectId: project,
        to: cutoff,
        order: "asc",
        cursor: options?.cursor,
        limit: options?.limit,
      };
      return list(
        d,
        count,
        query,
        JSON.stringify(["scanOlderThan", project, cutoff, count]),
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
