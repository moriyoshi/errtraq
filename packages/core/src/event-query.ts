import { decodeCursor, encodeCursor, pageLimit } from "./cursor.js";
import type {
  Cursor,
  EventId,
  EventPage,
  EventPosition,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "./domain.js";
import { InvalidCursorError } from "./errors.js";
import type { ActiveStore, ArchiveStore, EventQuery } from "./ports.js";

const encoder = new TextEncoder();

/** Unsigned UTF-8 byte order, the order both tiers sort by. */
function compareUtf8(a: string, b: string): number {
  if (a === b) return 0;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const delta = (x[i] ?? 0) - (y[i] ?? 0);
    if (delta) return delta;
  }
  return x.length - y.length;
}

function compareKeys(a: EventPosition, b: EventPosition): number {
  return (
    compareUtf8(a.receivedAt, b.receivedAt) || compareUtf8(a.eventId, b.eventId)
  );
}

/** The federation cursor is scoped to every filter, so it cannot be replayed on another query. */
function federationScope(q: EventQuery): string {
  return JSON.stringify([
    "fed",
    q.projectId,
    q.issueId ?? null,
    q.from ?? null,
    q.to ?? null,
    q.order ?? "desc",
  ]);
}

/** One source drained until it holds `want` rows or is exhausted; `more` means rows remain. */
async function drain(
  fetchPage: (cursor?: Cursor) => Promise<EventPage>,
  want: number,
): Promise<{ items: StoredEvent[]; more: boolean }> {
  const items: StoredEvent[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (!page.hasMore) return { items, more: false };
    if (items.length >= want) return { items, more: true };
    // An empty or short page with a continuation is legal (stale keys were examined).
    if (!page.nextCursor || page.nextCursor === cursor)
      throw new Error("Event source reports more rows without a continuation");
    cursor = page.nextCursor;
  }
}

export interface EventQueryServiceOptions {
  store: Pick<ActiveStore, "events" | "meta">;
  /** Absent means a single tier: every call passes straight through to the active store. */
  archive?: ArchiveStore;
}

/**
 * One read path over the active store and the archive. The active store is always queried; the
 * archive only when the range can reach below `archivedThrough`, which is read once per list
 * call and never cached across calls (the worker moves it). Pages are merged by
 * `(receivedAt, eventId)`, deduped on `eventId` (a row is in both tiers between the archival
 * MARK and DELETE steps), and resumed from the last emitted key, so the only state in the public
 * cursor is that key. Per-source cursors never leave this class.
 */
export class EventQueryService {
  constructor(private readonly options: EventQueryServiceOptions) {}

  async listByIssue(query: EventQuery): Promise<EventPage> {
    const { store, archive } = this.options;
    if (!archive) return store.events.listByIssue(query);
    const limit = pageLimit(query.limit);
    const order = query.order ?? "desc";
    const scope = federationScope(query);
    let after = query.after;
    if (query.cursor !== undefined) {
      if (query.after)
        throw new InvalidCursorError("Cursor and after are exclusive");
      const keys = decodeCursor(query.cursor, scope) ?? [];
      if (
        keys.length !== 2 ||
        typeof keys[0] !== "string" ||
        typeof keys[1] !== "string"
      )
        throw new InvalidCursorError("Invalid cursor");
      after = {
        receivedAt: keys[0] as Timestamp,
        eventId: keys[1] as EventId,
      };
    }
    const base = (): EventQuery => ({
      projectId: query.projectId,
      ...(query.issueId ? { issueId: query.issueId } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(after ? { after } : {}),
      order,
      limit,
    });
    const state = await store.meta.getArchiveState(query.projectId);
    const watermark = state?.archivedThrough;
    // Archive rows are older than the watermark; an ascending resume past it skips the archive.
    const archiveReachable =
      watermark !== undefined &&
      (!query.from || query.from < watermark) &&
      !(order === "asc" && after && after.receivedAt >= watermark);
    const [hot, cold] = await Promise.all([
      drain(
        (cursor) =>
          store.events.listByIssue({
            ...base(),
            ...(cursor ? { cursor } : {}),
          }),
        limit,
      ),
      archiveReachable
        ? drain(
            (cursor) =>
              archive.query({ ...base(), ...(cursor ? { cursor } : {}) }),
            limit,
          )
        : Promise.resolve({ items: [] as StoredEvent[], more: false }),
    ]);
    const unique = new Map<EventId, StoredEvent>();
    for (const row of [...hot.items, ...cold.items])
      if (!unique.has(row.eventId)) unique.set(row.eventId, row);
    const direction = order === "asc" ? 1 : -1;
    const merged = [...unique.values()].sort(
      (a, b) => direction * compareKeys(a, b),
    );
    const items = merged.slice(0, limit);
    const last = items.at(-1);
    const hasMore = merged.length > limit || hot.more || cold.more;
    return {
      items,
      hasMore: hasMore && last !== undefined,
      nextCursor:
        hasMore && last
          ? encodeCursor(scope, [last.receivedAt, last.eventId])
          : null,
    };
  }

  /** `hintTs` (for example `issue.lastEventReceivedAt`) lets an engine prune to one day. */
  async getEvent(
    projectId: ProjectId,
    eventId: EventId,
    hintTs?: Timestamp,
  ): Promise<StoredEvent | null> {
    const { store, archive } = this.options;
    const event = await store.events.get(projectId, eventId);
    if (event || !archive) return event;
    return archive.getEvent(projectId, eventId, hintTs);
  }
}
