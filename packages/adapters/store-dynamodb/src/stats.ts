import type {
  Cursor,
  FacetKey,
  IssueStatsRepo,
  Page,
  StatsIncrements,
  Timestamp,
} from "@moriyoshi/errtraq-core";
import {
  assertFacetKey,
  assertFacetLimit,
  assertStatsRange,
  DAY_MS,
  FACET_KEYS,
  InvalidCursorError,
  pageLimit,
  STATS_RETENTION_DAYS,
} from "@moriyoshi/errtraq-core/store";
import { DynamoStoreError } from "./errors.js";
import { indexCursor, partition, readIndexCursor, sortKey } from "./keys.js";
import {
  type Driver,
  get,
  hydrateRows,
  type Item,
  itemSize,
  primary,
  queryIndex,
  s,
} from "./repository-base.js";

/*
 * UI-d item types, all in the single table (see DYNAMODB_DESIGN.md, "Statistics items"):
 *
 *   hourly buckets   PK HB|project|issue          SK YYYY-MM-DD   attrs h00..h23 (N), ttlEpoch (N)
 *   facet value      PK FV|project|issue|key      SK component(value)
 *                    attrs count (N), val (S), GSI13PK = PK, GSI13SK = countSort|component(value)
 *   facet totals     PK FT|project|issue          SK DATA         attrs v0..v6 (N), c0..c6 (N)
 *
 * Counters change only inside the record transaction. Day items (one per issue and UTC day)
 * pack the 24 hourly counters, so a 30-day read is at most 31 items per issue.
 */
const GSI = "facet-count";
export const bucketKey = (project: string, issue: string) =>
  partition("HB", project, issue);
export const facetValueKey = (project: string, issue: string, key: string) =>
  partition("FV", project, issue, key);
export const facetTotalsKey = (project: string, issue: string) =>
  partition("FT", project, issue);

/** Descending count with an ascending value tie break, exactly like the issue-count index. */
export function facetCountSort(count: number, value: string): string {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new RangeError("Invalid facet count");
  const key = `${String(Number.MAX_SAFE_INTEGER - count).padStart(16, "0")}#${sortKey(value)}`;
  if (new TextEncoder().encode(key).length > 1024)
    throw new RangeError("DynamoDB sort key exceeds 1024 bytes");
  return key;
}
const dayOf = (hour: string) => hour.slice(0, 10);
const hourAttr = (hour: string) => `h${hour.slice(11, 13)}`;
/** TTL: the bucket's day ends, then 31 days; a stale item is harmless, reads are range-bound. */
function dayTtl(day: string): number {
  return Math.ceil(
    (Date.parse(`${day}T00:00:00.000Z`) + (1 + STATS_RETENTION_DAYS) * DAY_MS) /
      1000,
  );
}

export interface StatsPlan {
  writes: object[];
  /** Approximate transaction bytes of the counter writes (key plus attribute payload). */
  bytes: number;
}

/**
 * The counter actions of one record transaction, built from the increments of the events
 * that are really being inserted. One action per distinct day, per distinct (key, value) and
 * one for the per-key totals: at most 9 actions for a one-event call and 1 + 8m for m <= 10
 * events (D <= m days, F <= 7m values, one totals item).
 *
 * Facet value items need a count guard because their GSI sort key embeds the count, which
 * DynamoDB cannot compute inside the update: a strong BatchGetItem reads the current counts,
 * the update sets the new sort key and ADDs, conditioned on the old count (or absence). Every
 * writer of these items also guards the issue's own count in the same transaction, so a
 * failed guard here implies the issue guard fails too and the caller's existing retry loop
 * re-reads everything; the extra guards add no new contention domain.
 */
export async function planStats(
  d: Driver,
  projectId: string,
  issueId: string,
  increments: StatsIncrements,
): Promise<StatsPlan> {
  const writes: object[] = [];
  let bytes = 0;
  const days = new Map<string, Array<{ hour: string; count: number }>>();
  for (const bucket of increments.hours) {
    const list = days.get(dayOf(bucket.hour)) ?? [];
    list.push(bucket);
    days.set(dayOf(bucket.hour), list);
  }
  for (const [day, hours] of days) {
    const names: Record<string, string> = { "#ttl": "ttlEpoch" };
    const values: Record<string, unknown> = {
      ":ttl": { N: String(dayTtl(day)) },
    };
    const adds: string[] = [];
    for (const { hour, count } of hours) {
      const attr = hourAttr(hour);
      names[`#${attr}`] = attr;
      values[`:${attr}`] = { N: String(count) };
      adds.push(`#${attr} :${attr}`);
    }
    writes.push({
      Update: {
        TableName: d.table,
        Key: primary(bucketKey(projectId, issueId), day),
        UpdateExpression: `SET #ttl = :ttl ADD ${adds.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    });
    bytes += 400;
  }
  if (!increments.facets.length) return { writes, bytes };
  const rows: Item[] = increments.facets.map((f) =>
    primary(facetValueKey(projectId, issueId, f.key), sortKey(f.value)),
  );
  const current = await hydrateRows(d, rows);
  const totals = new Map<FacetKey, { values: number; count: number }>();
  for (const [index, facet] of increments.facets.entries()) {
    const row = rows[index] as Item;
    const old = current.get(JSON.stringify([row.PK?.S, row.SK?.S]));
    const oldCount = old ? Number(old.count?.N) : 0;
    if (old && !Number.isSafeInteger(oldCount))
      throw new DynamoStoreError("Invalid DynamoDB facet counter");
    const next = oldCount + facet.count;
    const sort = facetCountSort(next, facet.value);
    const names: Record<string, string> = {
      "#count": "count",
      "#val": "val",
      "#pk": "GSI13PK",
      "#sk": "GSI13SK",
    };
    const values: Record<string, unknown> = {
      ":n": { N: String(facet.count) },
      ":val": s(facet.value),
      ":pk": s(row.PK?.S ?? ""),
      ":sk": s(sort),
    };
    let condition = "attribute_not_exists(PK)";
    if (old) {
      values[":old"] = { N: String(oldCount) };
      condition = "#count = :old";
    }
    writes.push({
      Update: {
        TableName: d.table,
        Key: { PK: row.PK, SK: row.SK },
        UpdateExpression: "SET #val = :val, #pk = :pk, #sk = :sk ADD #count :n",
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    });
    bytes += itemSize({
      ...(row as Item),
      val: s(facet.value),
      GSI13PK: s(row.PK?.S ?? ""),
      GSI13SK: s(sort),
      count: { N: "1" },
    });
    const total = totals.get(facet.key) ?? { values: 0, count: 0 };
    total.count += facet.count;
    if (!old) total.values++;
    totals.set(facet.key, total);
  }
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const adds: string[] = [];
  for (const [key, total] of totals) {
    const i = FACET_KEYS.indexOf(key);
    names[`#c${i}`] = `c${i}`;
    values[`:c${i}`] = { N: String(total.count) };
    adds.push(`#c${i} :c${i}`);
    if (total.values) {
      names[`#v${i}`] = `v${i}`;
      values[`:v${i}`] = { N: String(total.values) };
      adds.push(`#v${i} :v${i}`);
    }
  }
  writes.push({
    Update: {
      TableName: d.table,
      Key: primary(facetTotalsKey(projectId, issueId)),
      UpdateExpression: `ADD ${adds.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  });
  bytes += 300;
  return { writes, bytes };
}

const ISSUE_READ_CONCURRENCY = 10;

export function statsRepository(d: Driver): IssueStatsRepo {
  async function top(
    projectId: string,
    issueId: string,
    key: FacetKey,
    limit: number,
    start?: Item,
  ): Promise<{ rows: Item[]; more: boolean }> {
    const result = await queryIndex(d, {
      TableName: d.table,
      IndexName: GSI,
      KeyConditionExpression: "GSI13PK = :pk",
      ExpressionAttributeValues: {
        ":pk": s(facetValueKey(projectId, issueId, key)),
      },
      Limit: limit + 1,
      ...(start ? { ExclusiveStartKey: start } : {}),
    });
    const rows = (result.Items ?? []) as Item[];
    return { rows: rows.slice(0, limit), more: rows.length > limit };
  }
  async function hydrate(rows: Item[]) {
    const full = await hydrateRows(d, rows);
    const out: Array<{ value: string; count: number }> = [];
    for (const row of rows) {
      const item = full.get(JSON.stringify([row.PK?.S, row.SK?.S]));
      const value = item?.val?.S;
      const count = Number(item?.count?.N);
      if (value !== undefined && Number.isSafeInteger(count))
        out.push({ value, count });
    }
    return out;
  }
  const byRank = (
    a: { value: string; count: number },
    b: { value: string; count: number },
  ) =>
    b.count - a.count ||
    (sortKey(a.value) < sortKey(b.value)
      ? -1
      : sortKey(a.value) > sortKey(b.value)
        ? 1
        : 0);
  return {
    expiry: "ttl",
    async series(projectId, issueIds, range) {
      assertStatsRange(issueIds, range);
      const ids = [...new Set(issueIds)];
      const from = Date.parse(range.from),
        to = Date.parse(range.to);
      const out = new Map<string, Array<{ hour: Timestamp; count: number }>>();
      const read = async (issueId: string) => {
        const buckets: Array<{ hour: Timestamp; count: number }> = [];
        out.set(issueId, buckets);
        if (to <= from) return;
        const first = range.from.slice(0, 10);
        const last = new Date(to - 1).toISOString().slice(0, 10);
        let start: Item | undefined;
        do {
          const page = await d.request("Query", {
            TableName: d.table,
            ConsistentRead: true,
            KeyConditionExpression: "PK = :pk AND SK BETWEEN :first AND :last",
            ExpressionAttributeValues: {
              ":pk": s(bucketKey(projectId, issueId)),
              ":first": s(first),
              ":last": s(last),
            },
            ...(start ? { ExclusiveStartKey: start } : {}),
          });
          for (const item of (page.Items ?? []) as Item[]) {
            const day = item.SK?.S;
            if (!day) continue;
            for (let h = 0; h < 24; h++) {
              const n = Number(item[`h${String(h).padStart(2, "0")}`]?.N ?? 0);
              if (!n) continue;
              const hour = `${day}T${String(h).padStart(2, "0")}:00:00.000Z`;
              if (hour >= range.from && hour < range.to)
                buckets.push({ hour: hour as Timestamp, count: n });
            }
          }
          start = page.LastEvaluatedKey as Item | undefined;
        } while (start);
        buckets.sort((a, b) =>
          a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0,
        );
      };
      for (let i = 0; i < ids.length; i += ISSUE_READ_CONCURRENCY)
        await Promise.all(
          ids.slice(i, i + ISSUE_READ_CONCURRENCY).map((id) => read(id)),
        );
      return ids.map((id) => ({
        issueId: id as never,
        buckets: out.get(id) ?? [],
      }));
    },
    async tagFacets(projectId, issueId, options) {
      assertFacetLimit(options.limit);
      const totals = await get(d, facetTotalsKey(projectId, issueId));
      if (!totals) return [];
      const present = FACET_KEYS.map((key, i) => ({
        key,
        totalValues: Number(totals[`v${i}`]?.N ?? 0),
        totalCount: Number(totals[`c${i}`]?.N ?? 0),
      })).filter((row) => row.totalCount > 0);
      // One bounded GSI read per present key, then one strong hydration of all candidates.
      const reads = await Promise.all(
        present.map((row) => top(projectId, issueId, row.key, options.limit)),
      );
      const hydrated = await hydrate(reads.flatMap((r) => r.rows));
      let offset = 0;
      return present.map((row, index) => {
        const size = reads[index]?.rows.length ?? 0;
        const values = hydrated.slice(offset, offset + size).sort(byRank);
        offset += size;
        return { ...row, topValues: values };
      });
    },
    async tagValues(projectId, issueId, key, options) {
      assertFacetKey(key);
      const hash = facetValueKey(projectId, issueId, key);
      const scope = JSON.stringify(["tag-values", projectId, issueId, key]);
      const size = pageLimit(options?.limit);
      const position = readIndexCursor(scope, options?.cursor as Cursor);
      if (position && position.indexPK !== hash)
        throw new InvalidCursorError("Cursor does not match index partition");
      const { rows, more } = await top(
        projectId,
        issueId,
        key,
        size,
        position
          ? {
              PK: s(position.PK),
              SK: s(position.SK),
              GSI13PK: s(position.indexPK),
              GSI13SK: s(position.indexSK),
            }
          : undefined,
      );
      const last = rows.at(-1);
      const nextCursor =
        more && last?.PK?.S && last.SK?.S && last.GSI13PK?.S && last.GSI13SK?.S
          ? indexCursor(scope, {
              PK: last.PK.S,
              SK: last.SK.S,
              indexPK: last.GSI13PK.S,
              indexSK: last.GSI13SK.S,
            })
          : null;
      const page: Page<{ value: string; count: number }> = {
        // Index order is the page order; counts are the hydrated, current ones.
        items: await hydrate(rows),
        nextCursor,
      };
      return page;
    },
    /** Buckets carry a TTL; there is no project-wide index of them, so nothing to sweep. */
    async deleteBefore() {
      return { deleted: 0, hasMore: false };
    },
  };
}
