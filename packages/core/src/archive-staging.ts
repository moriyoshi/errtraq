/**
 * The staged-batch codec: the one definition of what the archival worker writes to
 * `archive-staging/` and what the archive engines (and fakes) read back.
 *
 * Encoding is Parquet (pure JS, Workers-compatible). The staged object is the write-ahead record of
 * an archive batch: it is the exact content to append to the archive and the exact id list to delete
 * from the active store. Overflow payloads must already be re-inlined (the worker's job); this codec
 * only takes complete StoredEvents.
 *
 * Row schema (flat; column order is the table's column order):
 *
 *   project_id      STRING, required
 *   event_id        STRING, required
 *   issue_id        STRING, required
 *   timestamp       TIMESTAMP(MICROS, UTC), required   client clock, informational
 *   received_at     TIMESTAMP(MICROS, UTC), required   server clock; the partition and ordering key
 *   level           STRING, required
 *   release         STRING, optional
 *   environment     STRING, optional
 *   tags            MAP<STRING, STRING>, required      empty map when there are no tags
 *   user_id         STRING, optional                   promoted for erasure
 *   user_email      STRING, optional
 *   user_name       STRING, optional
 *   user_ip         STRING, optional
 *   event           STRING, required                   the full StoredEvent as JSON (the source of truth)
 *   archive_batch   STRING, required                   the batch id; the idempotency probe column
 *
 * Timestamps are INT64 microseconds with the TIMESTAMP(isAdjustedToUTC = true, MICROS) logical type,
 * which is what an Iceberg `timestamptz` column and DuckDB's `INSERT ... SELECT FROM read_parquet(...)`
 * expect. StoredEvent timestamps have millisecond precision, so the microsecond value is exact.
 */
import { parquetReadObjects } from "hyparquet/src/index.js";
import { parquetWriteBuffer } from "hyparquet-writer/src/index.js";
import type { Day, EventId, StoredEvent, Timestamp } from "./domain.js";

export const ARCHIVE_STAGING_PREFIX = "archive-staging/";
export const STAGED_BATCH_FORMAT_VERSION = "1";

/** Bounds of one batch: row count and an estimate of the uncompressed event bytes. */
export interface BatchLimits {
  maxRows: number;
  maxBytes: number;
}

export const DEFAULT_BATCH_LIMITS: Readonly<BatchLimits> = {
  maxRows: 50_000,
  maxBytes: 128 * 1024 * 1024,
};

export class ArchiveStagingError extends Error {
  override name = "ArchiveStagingError";
}

export interface BatchSummary {
  rowCount: number;
  /** Inclusive UTC days of receivedAt, [min, max]. */
  dayRange: [Day, Day];
  maxReceivedAt: Timestamp;
}

export interface EncodedBatch extends BatchSummary {
  bytes: Uint8Array;
  /** Event ids in row order: the exact list the DELETE step removes. */
  eventIds: EventId[];
}

export interface DecodedBatch {
  batchId: string;
  rows: StoredEvent[];
}

const encoder = new TextEncoder();

/** Fixed per-row cost added to the event JSON length for the promoted columns and Parquet framing. */
const ROW_OVERHEAD_BYTES = 256;

export function estimateEventBytes(event: StoredEvent): number {
  return encoder.encode(JSON.stringify(event)).length + ROW_OVERHEAD_BYTES;
}

export function dayOf(receivedAt: Timestamp): Day {
  return receivedAt.slice(0, 10) as Day;
}

function checkLimits(limits: BatchLimits): void {
  if (
    !Number.isSafeInteger(limits.maxRows) ||
    limits.maxRows < 1 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  )
    throw new ArchiveStagingError("Invalid batch limits");
}

/** Count, UTC day range and max receivedAt. An empty batch is never staged. */
export function summarizeBatch(rows: readonly StoredEvent[]): BatchSummary {
  if (rows.length === 0) throw new ArchiveStagingError("Empty batch");
  let min = rows[0]?.receivedAt as Timestamp;
  let max = min;
  for (const row of rows) {
    if (row.receivedAt < min) min = row.receivedAt;
    if (row.receivedAt > max) max = row.receivedAt;
  }
  return {
    rowCount: rows.length,
    dayRange: [dayOf(min), dayOf(max)],
    maxReceivedAt: max,
  };
}

/**
 * The longest prefix of `rows` within the limits. Always keeps at least one row so a single
 * oversized event cannot stall archival; the rest stays for the next batch.
 */
export function selectBatchPrefix(
  rows: readonly StoredEvent[],
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
): StoredEvent[] {
  checkLimits(limits);
  const selected: StoredEvent[] = [];
  let bytes = 0;
  for (const row of rows) {
    if (selected.length >= limits.maxRows) break;
    const size = estimateEventBytes(row);
    if (selected.length > 0 && bytes + size > limits.maxBytes) break;
    selected.push(row);
    bytes += size;
  }
  return selected;
}

const utf8 = (name: string, optional = false) =>
  ({
    name,
    type: "BYTE_ARRAY",
    converted_type: "UTF8",
    repetition_type: optional ? "OPTIONAL" : "REQUIRED",
  }) as const;
const timestamp = (name: string) =>
  ({
    name,
    type: "INT64",
    converted_type: "TIMESTAMP_MICROS",
    logical_type: { type: "TIMESTAMP", isAdjustedToUTC: true, unit: "MICROS" },
    repetition_type: "REQUIRED",
  }) as const;

// root num_children counts top-level columns only: the three map elements are nested.
const SCHEMA = [
  { name: "root", num_children: 15 },
  utf8("project_id"),
  utf8("event_id"),
  utf8("issue_id"),
  timestamp("timestamp"),
  timestamp("received_at"),
  utf8("level"),
  utf8("release", true),
  utf8("environment", true),
  {
    name: "tags",
    converted_type: "MAP",
    repetition_type: "REQUIRED",
    num_children: 1,
  },
  { name: "key_value", repetition_type: "REPEATED", num_children: 2 },
  utf8("key"),
  utf8("value", true),
  utf8("user_id", true),
  utf8("user_email", true),
  utf8("user_name", true),
  utf8("user_ip", true),
  utf8("event"),
  utf8("archive_batch"),
];

function toDate(value: Timestamp): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new ArchiveStagingError(`Invalid timestamp: ${value}`);
  return date;
}

function optional(value: string | undefined): string | null {
  return value ?? null;
}

/** Encode complete events into one Parquet object, rows in the given order. */
export function encodeStagedBatch(
  batchId: string,
  rows: readonly StoredEvent[],
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
): EncodedBatch {
  checkLimits(limits);
  if (!batchId) throw new ArchiveStagingError("Missing batch id");
  const summary = summarizeBatch(rows);
  if (rows.length > limits.maxRows)
    throw new ArchiveStagingError(
      `Batch has ${rows.length} rows, above the limit of ${limits.maxRows}`,
    );
  const events = rows.map((row) => JSON.stringify(row));
  const estimate = events.reduce(
    (sum, json) => sum + encoder.encode(json).length + ROW_OVERHEAD_BYTES,
    0,
  );
  if (estimate > limits.maxBytes && rows.length > 1)
    throw new ArchiveStagingError(
      `Batch is about ${estimate} bytes, above the limit of ${limits.maxBytes}`,
    );
  const column = <T>(name: string, pick: (row: StoredEvent) => T) => ({
    name,
    data: rows.map(pick),
  });
  const buffer = parquetWriteBuffer({
    schema: SCHEMA as never,
    columnData: [
      column("project_id", (r) => r.projectId),
      column("event_id", (r) => r.eventId),
      column("issue_id", (r) => r.issueId),
      column("timestamp", (r) => toDate(r.timestamp)),
      column("received_at", (r) => toDate(r.receivedAt)),
      column("level", (r) => r.level),
      column("release", (r) => optional(r.release)),
      column("environment", (r) => optional(r.environment)),
      column("tags", (r) =>
        Object.entries(r.tags).map(([key, value]) => ({ key, value })),
      ),
      column("user_id", (r) => optional(r.user?.id)),
      column("user_email", (r) => optional(r.user?.email)),
      column("user_name", (r) => optional(r.user?.username)),
      column("user_ip", (r) => optional(r.user?.ipAddress)),
      { name: "event", data: events },
      { name: "archive_batch", data: rows.map(() => batchId) },
    ],
    kvMetadata: [
      {
        key: "errtraq.staged-batch-format",
        value: STAGED_BATCH_FORMAT_VERSION,
      },
      { key: "errtraq.batch-id", value: batchId },
    ],
    createdBy: "errtraq",
  });
  return {
    ...summary,
    bytes: new Uint8Array(buffer),
    eventIds: rows.map((row) => row.eventId),
  };
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function readColumns(
  bytes: Uint8Array,
  columns: string[],
): Promise<Record<string, unknown>[]> {
  try {
    return await parquetReadObjects({
      file: arrayBuffer(bytes),
      columns,
      utf8: true,
    });
  } catch (error) {
    throw new ArchiveStagingError(
      `Unreadable staged batch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string")
    throw new ArchiveStagingError(`Corrupt staged batch: bad ${what}`);
  return value;
}

/** Decode a staged object back to StoredEvents, cross-checking the promoted columns. */
export async function decodeStagedBatch(
  bytes: Uint8Array,
): Promise<DecodedBatch> {
  const records = await readColumns(bytes, [
    "project_id",
    "event_id",
    "issue_id",
    "received_at",
    "event",
    "archive_batch",
  ]);
  if (records.length === 0)
    throw new ArchiveStagingError("Corrupt staged batch: no rows");
  const batchId = text(records[0]?.archive_batch, "archive_batch");
  const rows = records.map((record) => {
    let event: StoredEvent;
    try {
      event = JSON.parse(text(record.event, "event")) as StoredEvent;
    } catch (error) {
      if (error instanceof ArchiveStagingError) throw error;
      throw new ArchiveStagingError("Corrupt staged batch: bad event JSON");
    }
    const receivedAt = record.received_at;
    if (
      text(record.archive_batch, "archive_batch") !== batchId ||
      text(record.project_id, "project_id") !== event.projectId ||
      text(record.event_id, "event_id") !== event.eventId ||
      text(record.issue_id, "issue_id") !== event.issueId ||
      !(receivedAt instanceof Date) ||
      receivedAt.toISOString() !== event.receivedAt
    )
      throw new ArchiveStagingError(
        "Corrupt staged batch: columns disagree with the event JSON",
      );
    return event;
  });
  return { batchId, rows };
}

/** The id list for the DELETE step, without decoding the event payloads. */
export async function readStagedEventIds(
  bytes: Uint8Array,
): Promise<EventId[]> {
  const records = await readColumns(bytes, ["event_id"]);
  return records.map((record) => text(record.event_id, "event_id") as EventId);
}

const KEY_SUFFIX = ".parquet";

function escapePart(part: string): string {
  return encodeURIComponent(part).replace(
    /[-.!'()*~]/g,
    (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

export interface StagingKeyParts {
  batchId: string;
  /** Lease owner that wrote the object. */
  owner: string;
  /** Per-owner retry counter. Together with the owner it is the nonce. */
  attempt: number;
}

/**
 * `archive-staging/<batchId>-<owner>-<attempt>.parquet`, each part percent-escaped so the key is flat
 * and parseable. The owner/attempt nonce stops a stale lease holder from overwriting the object of a
 * newer owner of the same batch.
 */
export function stagingKey(parts: StagingKeyParts): string {
  if (!parts.batchId || !parts.owner)
    throw new ArchiveStagingError("Missing batch id or owner");
  if (!Number.isSafeInteger(parts.attempt) || parts.attempt < 0)
    throw new ArchiveStagingError("Invalid attempt");
  return `${ARCHIVE_STAGING_PREFIX}${escapePart(parts.batchId)}-${escapePart(parts.owner)}-${parts.attempt}${KEY_SUFFIX}`;
}

/** Inverse of stagingKey; null for anything that is not a staging key of this format. */
export function parseStagingKey(key: string): StagingKeyParts | null {
  if (!key.startsWith(ARCHIVE_STAGING_PREFIX) || !key.endsWith(KEY_SUFFIX))
    return null;
  const body = key.slice(ARCHIVE_STAGING_PREFIX.length, -KEY_SUFFIX.length);
  const pieces = body.split("-");
  if (pieces.length !== 3) return null;
  const [rawBatch, rawOwner, rawAttempt] = pieces as [string, string, string];
  if (!/^(0|[1-9]\d*)$/.test(rawAttempt)) return null;
  const attempt = Number(rawAttempt);
  if (!Number.isSafeInteger(attempt)) return null;
  try {
    const batchId = decodeURIComponent(rawBatch);
    const owner = decodeURIComponent(rawOwner);
    if (!batchId || !owner) return null;
    return { batchId, owner, attempt };
  } catch {
    return null;
  }
}
