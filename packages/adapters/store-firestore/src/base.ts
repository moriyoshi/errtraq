import type { Cursor, Page } from "@moriyoshi/errtraq-core";
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  pageLimit,
} from "@moriyoshi/errtraq-core/store";
import {
  decodeValue,
  documentSize,
  encodeFields,
  encodeValue,
  type Fields,
  type FirestoreClient,
  FirestoreDocumentTooLargeError,
  MAX_DOCUMENT_BYTES,
  NAME_FIELD,
  type Order,
  type Precondition,
  type Query,
  type RawDocument,
  type Transaction,
  type Write,
} from "@moriyoshi/errtraq-firestore-rest";

export type Reader = Pick<Transaction, "get" | "batchGet" | "runQuery">;
export const DATA = "data";

/** Plain index fields next to the JSON body (`data` is exempt from indexing, see indexes.ts). */
export function entityFields(
  index: Record<string, unknown>,
  body: unknown,
): Fields {
  return encodeFields({ ...index, [DATA]: JSON.stringify(body) });
}
export function entityData<T>(doc: RawDocument): T {
  const value = doc.fields[DATA];
  if (!value || !("stringValue" in value))
    throw new Error("Invalid Firestore store document");
  try {
    return JSON.parse(value.stringValue) as T;
  } catch {
    throw new Error("Invalid Firestore store document");
  }
}
export function field(doc: RawDocument, name: string): unknown {
  const value = doc.fields[name];
  return value === undefined ? undefined : decodeValue(value);
}
export function leaf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Ids pass the shared identifier limits, so they are always legal path segments. */
export function segment(id: string): string {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.includes("/") ||
    id === "." ||
    id === ".." ||
    /^__.*__$/.test(id) ||
    new TextEncoder().encode(id).length > 1500
  )
    throw new TypeError("Invalid Firestore path segment");
  return id;
}

/** Domain-separated SHA-256 of the parts, hex encoded: the document id of a natural key. */
export async function naturalKey(
  kind: string,
  ...parts: string[]
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([kind, ...parts]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sorted-key JSON, so a stored body compares equal to the same value written in another key order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export const set = (
  path: string,
  fields: Fields,
  precondition?: Precondition,
): Write => ({
  kind: "set",
  path,
  fields,
  ...(precondition ? { precondition } : {}),
});
export const create = (path: string, fields: Fields): Write =>
  set(path, fields, { exists: false });
export const remove = (path: string): Write => ({ kind: "delete", path });

/** Throws the client's size error before any request when a document would exceed 1 MiB. */
export function assertDocumentSize(path: string, fields: Fields): void {
  const size = documentSize(path, fields);
  if (size > MAX_DOCUMENT_BYTES)
    throw new FirestoreDocumentTooLargeError(
      `Firestore document exceeds 1 MiB (${size} bytes)`,
    );
}

/** At most 500 writes go into one commit (the conservative planning limit). */
export const MAX_COMMIT_WRITES = 500;
export async function commitChunked(
  client: FirestoreClient,
  writes: readonly Write[],
): Promise<void> {
  for (let i = 0; i < writes.length; i += MAX_COMMIT_WRITES)
    await client.commit(writes.slice(i, i + MAX_COMMIT_WRITES));
}

export interface PageSpec<T> {
  query: Omit<Query, "startAfter" | "limit">;
  scope: string;
  cursor?: Cursor;
  limit?: number;
  /** Decode one row. */
  read(doc: RawDocument): T;
}

/** The values a cursor stores for one row: each ordered field, `__name__` as the last path segment. */
function orderValues(
  orderBy: readonly Order[],
  doc: RawDocument,
): (string | number)[] {
  return orderBy.map((o) => {
    if (o.field === NAME_FIELD) return leaf(doc.path);
    const value = field(doc, o.field);
    if (typeof value !== "string" && typeof value !== "number")
      throw new Error("Invalid Firestore index field");
    return value;
  });
}

/**
 * Keyset page over a query ordered by explicit `orderBy` entries (ending in `__name__`, or in a
 * unique field). Fetches `limit + 1` rows so `nextCursor` is null exactly when exhausted.
 */
export async function pageQuery<T>(
  client: Reader,
  spec: PageSpec<T>,
): Promise<Page<T>> {
  const limit = pageLimit(spec.limit);
  const orderBy = spec.query.orderBy ?? [];
  const keys = decodeCursor(spec.cursor, spec.scope);
  let startAfter: Query["startAfter"];
  if (keys) {
    if (keys.length !== orderBy.length)
      throw new InvalidCursorError("Invalid cursor");
    startAfter = keys.map((key, i) => {
      const o = orderBy[i] as Order;
      if (o.field === NAME_FIELD) {
        if (typeof key !== "string")
          throw new InvalidCursorError("Invalid cursor");
        try {
          segment(key);
        } catch {
          throw new InvalidCursorError("Invalid cursor");
        }
        return {
          docPath: `${spec.query.parent ? `${spec.query.parent}/` : ""}${spec.query.collection}/${key}`,
        };
      }
      return encodeValue(key);
    });
  }
  const docs = await client.runQuery({
    ...spec.query,
    ...(startAfter ? { startAfter } : {}),
    limit: limit + 1,
  });
  const rows = docs.slice(0, limit);
  const last = docs.length > limit ? rows.at(-1) : undefined;
  return {
    items: rows.map(spec.read),
    nextCursor: last
      ? encodeCursor(spec.scope, orderValues(orderBy, last))
      : null,
  };
}
