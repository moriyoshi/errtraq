import type { Issue, IssueQuery, IssueRepo } from "@errtraq/core";
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  NotFoundError,
  pageLimit,
  UnsupportedQueryError,
} from "@errtraq/core/store";
import { DynamoStoreError } from "./errors.js";
import { issueFromItem, issueMutableAttributes } from "./issue-item.js";
import { issueTimeSort, partition, sortKey } from "./keys.js";
import { issueAttributes, issueStatusPartition } from "./record-event.js";
import {
  assertItemSize,
  type Driver,
  get,
  hydrateRows,
  type Item,
  primary,
  queryIndex,
  s,
} from "./repository-base.js";

export const issueKey = (project: string, id: string) =>
  partition("IS", project, id);
export const issuePointerKey = (id: string) => partition("ISSUEID", id);
export const issuePointerSort = (project: string) => sortKey(project);

/** Strong base-table pointer lookup; GSI propagation cannot hide newly created issues. */
export async function getIssuesById(d: Driver, id: string): Promise<Issue[]> {
  const result: Issue[] = [];
  let start: Item | undefined;
  do {
    const page = await d.request("Query", {
      TableName: d.table,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": s(issuePointerKey(id)) },
      ...(start ? { ExclusiveStartKey: start } : {}),
    });
    const pointers = (page.Items as Item[] | undefined) ?? [];
    for (let i = 0; i < pointers.length; i += 100) {
      let keys = pointers
        .slice(i, i + 100)
        .map((pointer) => ({ PK: s(pointer.owner?.S ?? ""), SK: s("DATA") }));
      for (let attempt = 0; keys.length && attempt < 10; attempt++) {
        const response = await d.request("BatchGetItem", {
          RequestItems: { [d.table]: { Keys: keys, ConsistentRead: true } },
        });
        const values = response.Responses as Record<string, Item[]> | undefined;
        for (const item of values?.[d.table] ?? []) {
          const issue = issueFromItem(item);
          if (issue?.id === id) result.push(issue);
        }
        const pending = response.UnprocessedKeys as
          | Record<string, { Keys?: typeof keys }>
          | undefined;
        keys = pending?.[d.table]?.Keys ?? [];
        if (keys.length)
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.random() * Math.min(250, 10 * 2 ** attempt),
            ),
          );
      }
      if (keys.length) throw new Error("Unable to hydrate issue pointers");
    }
    start = page.LastEvaluatedKey as Item | undefined;
  } while (start);
  return result.sort((a, b) => {
    const left = sortKey(a.projectId),
      right = sortKey(b.projectId);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
type Stream = {
  status: string;
  start?: Item;
  done: boolean;
  buffer?: Item[];
  terminal?: boolean;
};
async function listIssues(d: Driver, query: IssueQuery) {
  if (query.text || ((query.from || query.to) && query.sort !== "lastSeen"))
    throw new UnsupportedQueryError("Unsupported issue filter");
  const limit = pageLimit(query.limit),
    scope = JSON.stringify([
      "issues",
      query.projectId,
      query.sort,
      query.status ?? null,
      query.from ?? null,
      query.to ?? null,
    ]);
  const statuses = query.status
    ? [query.status]
    : ["unresolved", "resolved", "ignored"];
  const decoded = decodeCursor(query.cursor, scope);
  if (
    decoded &&
    (decoded.length !== statuses.length ||
      decoded.some((x) => typeof x !== "string"))
  )
    throw new InvalidCursorError("Invalid issue cursor");
  const streams: Stream[] = statuses.map((status, index) => {
    const raw = decoded?.[index];
    if (raw === "done") return { status, done: true };
    if (!raw) return { status, done: false };
    try {
      const tuple: unknown = JSON.parse(String(raw));
      if (
        !Array.isArray(tuple) ||
        tuple.length !== 4 ||
        tuple.some((x) => typeof x !== "string" || !x)
      )
        throw new Error();
      const [PK, SK, indexPK, indexSK] = tuple;
      const n =
        query.sort === "lastSeen" ? 4 : query.sort === "firstSeen" ? 5 : 6;
      if (indexPK !== issueStatusPartition(query.projectId, status))
        throw new Error();
      return {
        status,
        done: false,
        start: {
          PK: s(PK),
          SK: s(SK),
          [`GSI${n}PK`]: s(indexPK),
          [`GSI${n}SK`]: s(indexSK),
        },
      };
    } catch {
      throw new InvalidCursorError("Invalid issue cursor");
    }
  });
  const n = query.sort === "lastSeen" ? 4 : query.sort === "firstSeen" ? 5 : 6;
  const hash = `GSI${n}PK`,
    range = `GSI${n}SK`,
    index = n === 4 ? "issue-last" : n === 5 ? "issue-first" : "issue-count";
  if (query.from && query.to && query.from >= query.to)
    return { items: [], nextCursor: null };
  const lower = query.to
    ? `${issueTimeSort(query.to, "x").slice(0, 24)}#~`
    : undefined;
  const upper = query.from
    ? `${issueTimeSort(query.from, "x").slice(0, 24)}#~`
    : undefined;
  const items: Issue[] = [];
  const hydrated = new Map<string, Item>();
  while (items.length < limit) {
    const fetched: Item[] = [];
    for (const stream of streams) {
      if (stream.done || stream.buffer?.length) continue;
      if (stream.terminal) {
        stream.done = true;
        continue;
      }
      const result = await queryIndex(d, {
        TableName: d.table,
        IndexName: index,
        KeyConditionExpression: `#hash = :hash${lower && upper ? " AND #range BETWEEN :lower AND :upper" : lower ? " AND #range > :lower" : upper ? " AND #range < :upper" : ""}`,
        ExpressionAttributeNames: {
          "#hash": hash,
          ...(lower || upper ? { "#range": range } : {}),
        },
        ExpressionAttributeValues: {
          ":hash": s(issueStatusPartition(query.projectId, stream.status)),
          ...(lower ? { ":lower": s(lower) } : {}),
          ...(upper ? { ":upper": s(upper) } : {}),
        },
        Limit: Math.min(100, limit - items.length),
        ...(stream.start ? { ExclusiveStartKey: stream.start } : {}),
      });
      stream.buffer = (result.Items as Item[] | undefined) ?? [];
      stream.terminal = !result.LastEvaluatedKey;
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
      .sort((a, b) =>
        (a.buffer?.[0]?.[range]?.S ?? "") < (b.buffer?.[0]?.[range]?.S ?? "")
          ? -1
          : 1,
      );
    const selected = available[0];
    if (!selected?.buffer?.length) break;
    const row = selected.buffer.shift() as Item;
    selected.start = row;
    if (!selected.buffer.length && selected.terminal) selected.done = true;
    const hydrationKey = JSON.stringify([row.PK?.S, row.SK?.S]);
    const full = hydrated.get(hydrationKey),
      issue = issueFromItem(full);
    if (
      !streams.some((stream) =>
        stream.buffer?.some(
          (entry) => entry.PK?.S === row.PK?.S && entry.SK?.S === row.SK?.S,
        ),
      )
    )
      hydrated.delete(hydrationKey);
    if (
      issue &&
      issue.projectId === query.projectId &&
      issue.status === selected.status &&
      full?.[hash]?.S === row[hash]?.S &&
      full?.[range]?.S === row[range]?.S &&
      (!query.from || issue.lastSeen >= query.from) &&
      (!query.to || issue.lastSeen < query.to)
    )
      items.push(issue);
  }
  const nextCursor = streams.every((x) => x.done)
    ? null
    : encodeCursor(
        scope,
        streams.map((stream) => {
          if (stream.done) return "done";
          if (!stream.start) return "";
          return JSON.stringify([
            stream.start.PK?.S,
            stream.start.SK?.S,
            stream.start[hash]?.S,
            stream.start[range]?.S,
          ]);
        }),
      );
  return { items, nextCursor };
}
async function updateIssue(
  d: Driver,
  project: string,
  id: string,
  patch: Parameters<IssueRepo["update"]>[2],
): Promise<Issue> {
  const key = issueKey(project, id);
  for (let attempt = 0; attempt < 30; attempt++) {
    const old = await get(d, key),
      previous = issueFromItem(old);
    if (!previous || !old) throw new NotFoundError("Issue not found");
    const issue = { ...previous, ...patch },
      attrs = issueAttributes(issue);
    assertItemSize({
      ...primary(key),
      data: s(JSON.stringify(issue)),
      count: { N: String(issue.count) },
      ...attrs,
    });
    const legacy = !old.issueStatus?.S;
    const names: Record<string, string> = {
      "#status": "issueStatus",
      "#resolved": "resolvedAt",
    };
    const values: Record<string, unknown> = { ":status": s(issue.status) };
    const updates: Item = {
      issueStatus: s(issue.status),
      GSI4PK: attrs.GSI4PK,
      GSI5PK: attrs.GSI5PK,
      GSI6PK: attrs.GSI6PK,
    };
    if (legacy) Object.assign(updates, attrs, issueMutableAttributes(issue));
    if (issue.resolvedAt) updates.resolvedAt = s(issue.resolvedAt);
    const sets: string[] = [];
    for (const [name, value] of Object.entries(updates)) {
      names[`#${name}`] = name;
      values[`:${name}`] = value;
      sets.push(`#${name} = :${name}`);
    }
    delete values[":status"];
    let condition: string;
    if (legacy) {
      names["#data"] = "data";
      names["#count"] = "count";
      values[":old"] = old.data;
      values[":count"] = { N: String(previous.count) };
      condition = "#data = :old AND #count = :count";
      delete names["#status"];
      if (issue.resolvedAt) delete names["#resolved"];
    } else {
      values[":oldStatus"] = s(previous.status);
      condition = "#status = :oldStatus";
      if (previous.resolvedAt) {
        values[":oldResolved"] = s(previous.resolvedAt);
        condition += " AND #resolved = :oldResolved";
      } else condition += " AND attribute_not_exists(#resolved)";
    }
    try {
      const result = await d.request("UpdateItem", {
        TableName: d.table,
        Key: primary(key),
        UpdateExpression: `SET ${sets.join(", ")}${issue.resolvedAt ? "" : " REMOVE #resolved"}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      });
      return issueFromItem(result.Attributes as Item | undefined) ?? issue;
    } catch (error) {
      if (
        !(error instanceof DynamoStoreError) ||
        error.providerCode !== "ConditionalCheckFailedException"
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.random() * Math.min(25, 2 ** Math.min(attempt, 5)),
        ),
      );
    }
  }
  throw new DynamoStoreError(
    "DynamoDB issue update contention limit reached",
    "TransactionConflict",
    true,
  );
}
export function issueRepository(d: Driver): IssueRepo {
  return {
    get: async (project, id) =>
      issueFromItem(await get(d, issueKey(project, id))),
    getById: (id) => getIssuesById(d, id),
    list: (query) => listIssues(d, query),
    update: (project, id, patch) => updateIssue(d, project, id, patch),
    repairAfterErasure: async () => {
      throw new UnsupportedQueryError(
        "Subject erasure is unavailable until M4",
      );
    },
  };
}
