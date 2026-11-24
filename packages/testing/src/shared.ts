import type {
  Clock,
  Cursor,
  EventPage,
  EventQuery,
  IdGen,
  Page,
  StoredEvent,
  SubjectSelector,
  Timestamp,
} from "@moriyoshi/errtraq-core";
import {
  decodeCursor,
  encodeCursor,
  eventCursorScope,
  InvalidCursorError,
  pageLimit,
} from "@moriyoshi/errtraq-core";

export class FakeClock implements Clock {
  private time: number;
  constructor(now = "2024-01-01T00:00:00.000Z") {
    this.time = Date.parse(now);
  }
  now(): Timestamp {
    return new Date(this.time).toISOString() as Timestamp;
  }
  advance(milliseconds: number): void {
    this.time += milliseconds;
  }
}

export class DeterministicIdGen implements IdGen {
  private count = 0;
  next(): string {
    return `id-${++this.count}`;
  }
}

export const copy = <T>(value: T): T => structuredClone(value);

export function page<T>(
  items: T[],
  cursor: Cursor | undefined,
  limit: number | undefined,
  key: (item: T) => (string | number)[],
  scope: string,
  compare: (
    a: (string | number)[],
    b: (string | number)[],
  ) => number = compareKeys,
): Page<T> {
  const size = pageLimit(limit);
  const after = decodeCursor(cursor, scope);
  const first = items[0];
  if (
    after &&
    (first !== undefined
      ? key(first).length !== after.length
      : after.length === 0)
  )
    throw new InvalidCursorError("Invalid cursor shape");
  const rows = after
    ? items.filter((item) => compare(key(item), after) > 0)
    : items;
  const selected = rows.slice(0, size);
  const last = selected.at(-1);
  return {
    items: copy(selected),
    nextCursor:
      rows.length > size && last !== undefined
        ? encodeCursor(scope, key(last))
        : null,
  };
}
export function compareKeys(
  a: (string | number)[],
  b: (string | number)[],
): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    if (x === undefined || y === undefined) return 0;
    if (typeof x === "string" && typeof y === "string") {
      const order = compareUtf8(x, y);
      if (order) return order;
    } else {
      if (x < y) return -1;
      if (x > y) return 1;
    }
  }
  return 0;
}

export function eventOrder(a: StoredEvent, b: StoredEvent): number {
  return (
    compareUtf8(a.receivedAt, b.receivedAt) || compareUtf8(a.eventId, b.eventId)
  );
}

export function matchesSubject(
  event: StoredEvent,
  selector: SubjectSelector,
): boolean {
  if (selector.kind === "eventIds")
    return selector.eventIds.includes(event.eventId);
  const key = selector.kind === "userId" ? "id" : selector.kind;
  return event.user?.[key] === selector.value;
}

export async function bytes(
  body: Uint8Array | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.slice();
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    chunks.push(item.value);
  }
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function stream(data: Uint8Array): ReadableStream<Uint8Array> {
  const dataCopy = data.slice();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(dataCopy);
      controller.close();
    },
  });
}

/** Keyset pages remain usable after a federated merge emits only a prefix. */
export function eventPage(rows: StoredEvent[], query: EventQuery): EventPage {
  const direction = query.order === "asc" ? 1 : -1;
  const scope = eventCursorScope(query);
  const keys = decodeCursor(query.cursor, scope);
  if (
    keys &&
    (keys.length !== 2 ||
      typeof keys[0] !== "string" ||
      typeof keys[1] !== "string")
  )
    throw new InvalidCursorError("Invalid event cursor");
  const boundary = keys
    ? { receivedAt: String(keys[0]), eventId: String(keys[1]) }
    : query.after;
  const remaining = rows
    .sort((a, b) => direction * eventOrder(a, b))
    .filter(
      (row) =>
        !boundary ||
        direction *
          (compareUtf8(row.receivedAt, boundary.receivedAt) ||
            compareUtf8(row.eventId, boundary.eventId)) >
          0,
    );
  const limit = pageLimit(query.limit);
  const selected = remaining.slice(0, limit);
  const last = selected.at(-1);
  const nextCursor =
    remaining.length > limit && last
      ? encodeCursor(scope, [last.receivedAt, last.eventId])
      : null;
  return { items: copy(selected), hasMore: nextCursor !== null, nextCursor };
}

/** Compare strings as unsigned UTF-8 bytes. */
export function compareUtf8(a: string, b: string): number {
  const x = new TextEncoder().encode(a),
    y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const delta = (x[i] ?? 0) - (y[i] ?? 0);
    if (delta) return delta;
  }
  return x.length - y.length;
}
