/**
 * The archive row definition: what an archive engine stores per event, plus the batch bounds the
 * archival worker uses. Engines (M4f and later) derive their table columns from `archiveRow`.
 */
import type {
  Day,
  EventId,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "./domain.js";

/** Bounds of one batch: row count and an estimate of the uncompressed event bytes. */
export interface BatchLimits {
  maxRows: number;
  maxBytes: number;
}

export const DEFAULT_BATCH_LIMITS: Readonly<BatchLimits> = {
  maxRows: 50_000,
  maxBytes: 128 * 1024 * 1024,
};

export class ArchiveRowError extends Error {
  override name = "ArchiveRowError";
}

export interface BatchSummary {
  rowCount: number;
  /** Inclusive UTC days of receivedAt, [min, max]. */
  dayRange: [Day, Day];
  maxReceivedAt: Timestamp;
}

/**
 * One archive table row: the promoted columns (partitioning, filtering, erasure) plus the full
 * StoredEvent as JSON, which stays the source of truth on read. Overflow payloads must already be
 * re-inlined. Timestamps are canonical UTC millisecond strings; an engine stores them as
 * microsecond `timestamptz`.
 */
export interface ArchiveRow {
  project_id: ProjectId;
  event_id: EventId;
  issue_id: string;
  timestamp: Timestamp;
  received_at: Timestamp;
  level: string;
  release: string | null;
  environment: string | null;
  tags: Record<string, string>;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  user_ip: string | null;
  event: string;
  archive_batch: string;
}

const encoder = new TextEncoder();

/** Fixed per-row cost added to the event JSON length for the promoted columns and file framing. */
const ROW_OVERHEAD_BYTES = 256;

export function estimateEventBytes(event: StoredEvent): number {
  return encoder.encode(JSON.stringify(event)).length + ROW_OVERHEAD_BYTES;
}

export function dayOf(receivedAt: Timestamp): Day {
  return receivedAt.slice(0, 10) as Day;
}

export function archiveRow(batchId: string, event: StoredEvent): ArchiveRow {
  if (!batchId) throw new ArchiveRowError("Missing batch id");
  if (event.payloadBlobKey)
    throw new ArchiveRowError("Overflow payload must be re-inlined");
  return {
    project_id: event.projectId,
    event_id: event.eventId,
    issue_id: event.issueId,
    timestamp: event.timestamp,
    received_at: event.receivedAt,
    level: event.level,
    release: event.release ?? null,
    environment: event.environment ?? null,
    tags: event.tags,
    user_id: event.user?.id ?? null,
    user_email: event.user?.email ?? null,
    user_name: event.user?.username ?? null,
    user_ip: event.user?.ipAddress ?? null,
    event: JSON.stringify(event),
    archive_batch: batchId,
  };
}

/** Count, UTC day range and max receivedAt. An empty batch is never committed. */
export function summarizeBatch(rows: readonly StoredEvent[]): BatchSummary {
  if (rows.length === 0) throw new ArchiveRowError("Empty batch");
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
  if (
    !Number.isSafeInteger(limits.maxRows) ||
    limits.maxRows < 1 ||
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1
  )
    throw new ArchiveRowError("Invalid batch limits");
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
