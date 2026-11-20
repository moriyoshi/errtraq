import type {
  Clock,
  Cursor,
  IdGen,
  Page,
  StoredEvent,
  SubjectSelector,
  Timestamp,
} from "@errtraq/core";

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

export function page<T>(items: T[], cursor?: Cursor, limit = 100): Page<T> {
  const start = cursor ? Number(cursor) : 0;
  const end = Math.min(items.length, start + Math.max(1, limit));
  return {
    items: copy(items.slice(start, end)),
    nextCursor: end < items.length ? (String(end) as Cursor) : null,
  };
}

export function eventOrder(a: StoredEvent, b: StoredEvent): number {
  return (
    a.receivedAt.localeCompare(b.receivedAt) ||
    a.eventId.localeCompare(b.eventId)
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
