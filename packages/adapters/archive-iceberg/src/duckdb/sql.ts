// SQL generation for the DuckDB engine. Pure functions, no DuckDB import, so the statements can be
// unit-tested as plain strings. Every value goes through a bound parameter (`?`); the only text
// interpolated into a statement is (a) identifiers, which must match a strict pattern, (b)
// snapshot ids validated as integers, and (c) literals in DDL and ATTACH/SECRET statements, where
// DuckDB accepts no parameters and the values are operator configuration (never event data).
import {
  archiveRow,
  type Day,
  type EventId,
  type EventPosition,
  type EventQuery,
  type ProjectId,
  type StoredEvent,
  type Timestamp,
} from "@moriyoshi/errtraq-core";

export interface Statement {
  sql: string;
  params: unknown[];
}

/** Name the catalog is ATTACHed under inside the DuckDB instance. */
export const CATALOG_ALIAS = "lake";
export const EVENTS_TABLE = "events";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name))
    throw new TypeError(`Invalid SQL identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** A single-quoted DuckDB string literal. Only for DDL, ATTACH and SECRET (no parameters there). */
export function quoteLiteral(value: string): string {
  if (value.includes("\0"))
    throw new TypeError("SQL literal contains a NUL byte");
  return `'${value.replaceAll("'", "''")}'`;
}

export function tableRef(namespace: string, table = EVENTS_TABLE): string {
  return `${CATALOG_ALIAS}.${quoteIdentifier(namespace)}.${quoteIdentifier(table)}`;
}

/**
 * The events table columns: the promoted columns of `archiveRow` plus `event` (the full
 * StoredEvent JSON) and `archive_batch`. Timestamps are microsecond `timestamptz`.
 */
export const EVENT_COLUMNS = [
  ["project_id", "VARCHAR"],
  ["event_id", "VARCHAR"],
  ["issue_id", "VARCHAR"],
  ["timestamp", "TIMESTAMPTZ"],
  ["received_at", "TIMESTAMPTZ"],
  ["level", "VARCHAR"],
  ["release", "VARCHAR"],
  ["environment", "VARCHAR"],
  ["tags", "MAP(VARCHAR, VARCHAR)"],
  ["user_id", "VARCHAR"],
  ["user_email", "VARCHAR"],
  ["user_name", "VARCHAR"],
  ["user_ip", "VARCHAR"],
  ["event", "VARCHAR"],
  ["archive_batch", "VARCHAR"],
] as const;

/** D13: files are sorted so project and issue reads prune well. */
export const SORT_ORDER = ["project_id", "issue_id", "received_at"] as const;
export const PARTITION_EXPRESSION = "day(received_at)";

export function tableExistsStatement(namespace: string): Statement {
  return {
    sql: "SELECT count(*) AS c FROM duckdb_tables() WHERE database_name = ? AND schema_name = ? AND table_name = ?",
    params: [CATALOG_ALIAS, namespace, EVENTS_TABLE],
  };
}

/**
 * The DDL statements that bootstrap the table, in order. They must run in a session of their own
 * before the first INSERT (the partition spec and the sort order only apply to later writes).
 */
export function ensureTableStatements(
  namespace: string,
  formatVersion: 2 | 3,
): string[] {
  const table = tableRef(namespace);
  const columns = EVENT_COLUMNS.map(
    ([name, type]) => `${quoteIdentifier(name)} ${type}`,
  ).join(", ");
  return [
    `CREATE SCHEMA IF NOT EXISTS ${CATALOG_ALIAS}.${quoteIdentifier(namespace)}`,
    `CREATE TABLE ${table} (${columns}) WITH ('format-version' = ${formatVersion})`,
    `ALTER TABLE ${table} SET PARTITIONED BY (${PARTITION_EXPRESSION})`,
    `ALTER TABLE ${table} SET SORTED BY (${SORT_ORDER.join(", ")})`,
    `ALTER TABLE ${table} SET ('write.delete.mode' = 'merge-on-read')`,
  ];
}

const STRUCT_SPEC = JSON.stringify([
  Object.fromEntries(EVENT_COLUMNS.map(([name, type]) => [name, type])),
]);

/**
 * One INSERT for the whole batch. The rows travel as a single JSON array parameter that DuckDB
 * unnests into typed columns, so no row data is ever part of the SQL text.
 */
export function appendStatement(
  namespace: string,
  batchId: string,
  rows: readonly StoredEvent[],
): Statement {
  const json = JSON.stringify(rows.map((row) => archiveRow(batchId, row)));
  const columns = EVENT_COLUMNS.map(([name]) => `r.${quoteIdentifier(name)}`);
  return {
    sql: `INSERT INTO ${tableRef(namespace)} SELECT ${columns.join(", ")} FROM (SELECT unnest(from_json(CAST(? AS JSON), ${quoteLiteral(STRUCT_SPEC)})) AS r)`,
    params: [json],
  };
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function dayStartMs(day: Day): number {
  const ms = DAY_PATTERN.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day)
    throw new TypeError(`Invalid day: ${JSON.stringify(day)}`);
  return ms;
}
/** `[start, end)` UTC timestamps covering the inclusive day range. */
export function dayRangeBounds(range: [Day, Day]): [Timestamp, Timestamp] {
  const start = dayStartMs(range[0]);
  const end = dayStartMs(range[1]) + 86_400_000;
  if (end <= start) throw new TypeError("Day range is reversed");
  return [
    new Date(start).toISOString() as Timestamp,
    new Date(end).toISOString() as Timestamp,
  ];
}

const RANGE_PREDICATE =
  "received_at >= CAST(? AS TIMESTAMPTZ) AND received_at < CAST(? AS TIMESTAMPTZ)";

export function hasBatchStatement(
  namespace: string,
  batchId: string,
  range: [Day, Day],
  options: { snapshotId?: string } = {},
): Statement {
  return {
    sql: `SELECT 1 AS found FROM ${tableRef(namespace)}${versionClause(options.snapshotId)} WHERE archive_batch = ? AND ${RANGE_PREDICATE} LIMIT 1`,
    params: [batchId, ...dayRangeBounds(range)],
  };
}

export function batchEventIdsStatement(
  namespace: string,
  projectId: ProjectId,
  batchId: string,
  range: [Day, Day],
): Statement {
  return {
    sql: `SELECT event_id FROM ${tableRef(namespace)} WHERE project_id = ? AND archive_batch = ? AND ${RANGE_PREDICATE} ORDER BY event_id`,
    params: [projectId, batchId, ...dayRangeBounds(range)],
  };
}

export function snapshotsStatement(namespace: string): Statement {
  return {
    sql: `SELECT CAST(snapshot_id AS VARCHAR) AS snapshot_id FROM iceberg_snapshots(${tableRef(namespace)}) ORDER BY sequence_number`,
    params: [],
  };
}

const SNAPSHOT_ID = /^-?\d{1,19}$/;
/** Time travel to a snapshot id. DuckDB takes a literal here; the id is validated as an integer. */
function versionClause(snapshotId: string | undefined): string {
  if (snapshotId === undefined) return "";
  if (!SNAPSHOT_ID.test(snapshotId)) throw new TypeError("Invalid snapshot id");
  return ` AT (VERSION => ${snapshotId})`;
}

/**
 * Keyset SQL for `ArchiveStore.query`: `ORDER BY received_at, event_id` (binary string order, the
 * same as the other stores), exclusive `boundary`, and `limit + 1` rows so the caller can derive
 * `hasMore`.
 */
export function queryStatement(
  namespace: string,
  query: Pick<EventQuery, "projectId" | "issueId" | "from" | "to" | "order">,
  boundary: EventPosition | undefined,
  limit: number,
): Statement {
  const descending = query.order !== "asc";
  const where = ["project_id = ?"];
  const params: unknown[] = [query.projectId];
  if (query.issueId) {
    where.push("issue_id = ?");
    params.push(query.issueId);
  }
  if (query.from) {
    where.push("received_at >= CAST(? AS TIMESTAMPTZ)");
    params.push(query.from);
  }
  if (query.to) {
    where.push("received_at < CAST(? AS TIMESTAMPTZ)");
    params.push(query.to);
  }
  if (boundary) {
    where.push(
      `(received_at, event_id) ${descending ? "<" : ">"} (CAST(? AS TIMESTAMPTZ), ?)`,
    );
    params.push(boundary.receivedAt, boundary.eventId);
  }
  const direction = descending ? "DESC" : "ASC";
  params.push(limit + 1);
  return {
    sql: `SELECT event FROM ${tableRef(namespace)} WHERE ${where.join(" AND ")} ORDER BY received_at ${direction}, event_id ${direction} LIMIT ?`,
    params,
  };
}

/** Point lookup; with a hint it prunes to the hint's UTC day. */
export function getEventStatement(
  namespace: string,
  projectId: ProjectId,
  eventId: EventId,
  hintDay?: Day,
): Statement {
  const params: unknown[] = [projectId, eventId];
  let sql = `SELECT event FROM ${tableRef(namespace)} WHERE project_id = ? AND event_id = ?`;
  if (hintDay) {
    sql += ` AND ${RANGE_PREDICATE}`;
    params.push(...dayRangeBounds([hintDay, hintDay]));
  }
  return { sql: `${sql} LIMIT 1`, params };
}
