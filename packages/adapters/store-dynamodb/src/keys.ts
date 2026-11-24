import type { Cursor } from "@moriyoshi/errtraq-core";
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
} from "@moriyoshi/errtraq-core/store";

/** Hex-encoded UTF-8 preserves byte order; ! terminates each component before any hex digit. */
export function component(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("Invalid DynamoDB key component");
  const bytes = new TextEncoder().encode(value);
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value)
    throw new TypeError("Invalid DynamoDB key component");
  return `${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}!`;
}
export function partition(prefix: string, ...parts: string[]): string {
  const key = `${prefix}|${parts.map(component).join("|")}`;
  if (new TextEncoder().encode(key).length > 2048)
    throw new RangeError("DynamoDB partition key exceeds 2048 bytes");
  return key;
}
export function sortKey(value: string): string {
  const key = component(value);
  if (new TextEncoder().encode(key).length > 1024)
    throw new RangeError("DynamoDB sort key exceeds 1024 bytes");
  return key;
}
/** Descending timestamp with an ascending, UTF-8 ordered issue-ID tie break. */
export function issueTimeSort(timestamp: string, issueId: string): string {
  const millis = Date.parse(timestamp);
  if (
    timestamp.length !== 24 ||
    !Number.isFinite(millis) ||
    new Date(millis).toISOString() !== timestamp
  )
    throw new TypeError("Expected a canonical UTC millisecond timestamp");
  const descending = timestamp.replace(/[0-9]/g, (digit) =>
    String(9 - Number(digit)),
  );
  const key = `${descending}#${sortKey(issueId)}`;
  if (new TextEncoder().encode(key).length > 1024)
    throw new RangeError("DynamoDB sort key exceeds 1024 bytes");
  return key;
}

/** Descending safe-integer count with an ascending issue-ID tie break. */
export function issueCountSort(count: number, issueId: string): string {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new RangeError("Invalid issue count");
  const key = `${String(Number.MAX_SAFE_INTEGER - count).padStart(16, "0")}#${sortKey(issueId)}`;
  if (new TextEncoder().encode(key).length > 1024)
    throw new RangeError("DynamoDB sort key exceeds 1024 bytes");
  return key;
}

export function eventTimeSort(timestamp: string, eventId: string): string {
  const millis = Date.parse(timestamp);
  if (
    timestamp.length !== 24 ||
    !Number.isFinite(millis) ||
    new Date(millis).toISOString() !== timestamp
  )
    throw new TypeError("Expected a canonical UTC millisecond timestamp");
  const key = `${timestamp}#${sortKey(eventId)}`;
  if (new TextEncoder().encode(key).length > 1024)
    throw new RangeError("DynamoDB sort key exceeds 1024 bytes");
  return key;
}
export interface IndexPosition {
  PK: string;
  SK: string;
  indexPK: string;
  indexSK: string;
}
/** Only the last consumed/examined key may advance the cursor; prefetched rows do not. */
export function indexCursor(scope: string, position: IndexPosition): Cursor {
  return encodeCursor(scope, [
    position.PK,
    position.SK,
    position.indexPK,
    position.indexSK,
  ]);
}
export function readIndexCursor(
  scope: string,
  cursor?: Cursor,
): IndexPosition | undefined {
  const values = decodeCursor(cursor, scope);
  if (!values) return undefined;
  if (
    values.length !== 4 ||
    values.some((value) => typeof value !== "string" || !value)
  )
    throw new InvalidCursorError("Invalid DynamoDB index cursor");
  const [PK, SK, indexPK, indexSK] = values;
  if (
    typeof PK !== "string" ||
    typeof SK !== "string" ||
    typeof indexPK !== "string" ||
    typeof indexSK !== "string"
  )
    throw new InvalidCursorError("Invalid DynamoDB index cursor");
  return { PK, SK, indexPK, indexSK };
}
