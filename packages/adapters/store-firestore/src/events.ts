import type {
  Cursor,
  EventId,
  EventPage,
  EventQuery,
  EventRepo,
  StoredEvent,
} from "@moriyoshi/errtraq-core";
import {
  decodeCursor,
  encodeCursor,
  eventCursorScope,
  InvalidCursorError,
  pageLimit,
  UnsupportedQueryError,
} from "@moriyoshi/errtraq-core/store";
import {
  encodeFields,
  type Fields,
  type FirestoreClient,
  NAME_FIELD,
  type Query,
  type RawDocument,
} from "@moriyoshi/errtraq-firestore-rest";
import {
  assertDocumentSize,
  commitChunked,
  DATA,
  entityData,
  field,
  pageQuery,
  remove,
  segment,
} from "./base.js";
import { gunzip, gzip } from "./codec.js";

export const eventPath = (projectId: string, eventId: string) =>
  `projects/${segment(projectId)}/events/${segment(eventId)}`;
const eventsParent = (projectId: string) => `projects/${segment(projectId)}`;

/**
 * The event body without its payload is a JSON string; the payload is gzipped JSON in a bytes
 * field. Both are exempt from indexing (see indexes.ts). The oversize guard runs here, so an
 * event that cannot fit in one document is rejected and never truncated.
 */
export async function eventFields(event: StoredEvent): Promise<Fields> {
  const { payload, ...body } = event;
  const fields: Fields = {
    ...encodeFields({
      issueId: event.issueId,
      receivedAt: event.receivedAt,
      [DATA]: JSON.stringify(body),
      payload: await gzip(new TextEncoder().encode(JSON.stringify(payload))),
    }),
  };
  assertDocumentSize(eventPath(event.projectId, event.eventId), fields);
  return fields;
}
export async function readEvent(doc: RawDocument): Promise<StoredEvent> {
  const body = entityData<Omit<StoredEvent, "payload">>(doc);
  const bytes = field(doc, "payload");
  if (!(bytes instanceof Uint8Array)) throw new Error("Invalid event document");
  const payload: unknown = JSON.parse(
    new TextDecoder().decode(await gunzip(bytes)),
  );
  return { ...body, payload } as StoredEvent;
}

export function eventRepository(client: FirestoreClient): EventRepo {
  const readAll = (docs: RawDocument[]) => Promise.all(docs.map(readEvent));
  return {
    capabilities: { deleteStrategy: "explicit", deleteBySubject: false },
    get: async (projectId, eventId) => {
      const doc = await client.get(eventPath(projectId, eventId));
      return doc ? readEvent(doc) : null;
    },
    listByIssue: async (q: EventQuery): Promise<EventPage> => {
      const limit = pageLimit(q.limit);
      const direction = q.order === "asc" ? "ASC" : "DESC";
      const scope = eventCursorScope(q);
      const keys = decodeCursor(q.cursor, scope);
      const position = keys
        ? keys
        : q.after
          ? [q.after.receivedAt, q.after.eventId]
          : undefined;
      if (
        position &&
        (position.length !== 2 ||
          typeof position[0] !== "string" ||
          typeof position[1] !== "string")
      )
        throw new InvalidCursorError("Invalid cursor");
      const where: NonNullable<Query["where"]> = [];
      if (q.issueId)
        where.push({
          field: "issueId",
          op: "EQUAL",
          value: { stringValue: q.issueId },
        });
      if (q.from)
        where.push({
          field: "receivedAt",
          op: "GREATER_THAN_OR_EQUAL",
          value: { stringValue: q.from },
        });
      if (q.to)
        where.push({
          field: "receivedAt",
          op: "LESS_THAN",
          value: { stringValue: q.to },
        });
      const parent = eventsParent(q.projectId);
      if (position) {
        try {
          segment(position[1] as string);
        } catch {
          throw new InvalidCursorError("Invalid cursor");
        }
      }
      const docs = await client.runQuery({
        parent,
        collection: "events",
        where,
        orderBy: [
          { field: "receivedAt", direction },
          { field: NAME_FIELD, direction },
        ],
        ...(position
          ? {
              startAfter: [
                { stringValue: position[0] as string },
                { docPath: `${parent}/events/${position[1]}` },
              ],
            }
          : {}),
        limit: limit + 1,
      });
      const rows = docs.slice(0, limit);
      const items = await readAll(rows);
      const last = items.at(-1);
      const hasMore = docs.length > limit && last !== undefined;
      return {
        items,
        hasMore,
        nextCursor: hasMore
          ? encodeCursor(scope, [last.receivedAt, last.eventId])
          : null,
      };
    },
    scanOlderThan: async (projectId, cutoff, options) => {
      const page = await pageQuery(client, {
        query: {
          parent: eventsParent(projectId),
          collection: "events",
          where: [
            {
              field: "receivedAt",
              op: "LESS_THAN",
              value: { stringValue: cutoff },
            },
          ],
          orderBy: [
            { field: "receivedAt", direction: "ASC" },
            { field: NAME_FIELD, direction: "ASC" },
          ],
        },
        scope: JSON.stringify(["scan", projectId, cutoff]),
        cursor: options?.cursor as Cursor | undefined,
        limit: options?.limit,
        read: (doc) => doc,
      });
      return {
        items: await readAll(page.items),
        nextCursor: page.nextCursor,
      };
    },
    deleteBatch: async (projectId, ids: EventId[]) => {
      await commitChunked(
        client,
        [...new Set(ids)].map((id) => remove(eventPath(projectId, id))),
      );
    },
    deleteBySubject: async () => {
      throw new UnsupportedQueryError(
        "Subject erasure is unavailable until M4",
      );
    },
  };
}
