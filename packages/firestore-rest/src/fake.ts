/**
 * An in-process fake of the Firestore REST surface this package uses, served as a `fetch`
 * function. It implements documents get/batchGet/commit (preconditions, masks, increment
 * transforms), runQuery (filters, ordering, cursors, limits), and optimistic transactions that
 * abort on conflict. With `indexes` set it also rejects queries a real database would reject for
 * a missing composite index, so a contract run over the fake proves index coverage.
 */
import {
  type CompositeIndex,
  isServed,
  NAME_FIELD,
  type StructuredQuery,
  shapeOfStructured,
} from "./query.js";
import type { Fields, Value } from "./value.js";

interface StoredDocument {
  fields: Fields;
  createTime: string;
  updateTime: string;
}
interface TransactionState {
  reads: Map<string, string | null>;
  queries: { parent: string; query: StructuredQuery; signature: string }[];
}
export interface FakeRequest {
  method: string;
  /** `get`, `batchGet`, `runQuery`, `commit`, `beginTransaction` or `rollback`. */
  action: string;
  body: unknown;
}
export interface FakeFirestoreOptions {
  projectId?: string;
  databaseId?: string;
  /** Reject queries not served by an automatic or declared composite index. */
  indexes?: readonly CompositeIndex[];
  /** Return a response to short-circuit a request (fault injection). */
  intercept?: (request: FakeRequest) => Response | undefined;
}

const encoder = new TextEncoder();
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const delta = (x[i] as number) - (y[i] as number);
    if (delta) return delta;
  }
  return x.length - y.length;
}
function comparePaths(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const delta = compareStrings(x[i] as string, y[i] as string);
    if (delta) return delta;
  }
  return x.length - y.length;
}
function typeRank(value: Value): number {
  if ("nullValue" in value) return 0;
  if ("booleanValue" in value) return 1;
  if ("integerValue" in value || "doubleValue" in value) return 2;
  if ("timestampValue" in value) return 3;
  if ("stringValue" in value) return 4;
  if ("bytesValue" in value) return 5;
  if ("referenceValue" in value) return 6;
  if ("arrayValue" in value) return 7;
  return 8;
}
function number(value: Value): number {
  return "integerValue" in value
    ? Number(value.integerValue)
    : Number((value as { doubleValue: number | string }).doubleValue);
}
export function compareValues(a: Value, b: Value): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if ("booleanValue" in a && "booleanValue" in b)
    return Number(a.booleanValue) - Number(b.booleanValue);
  if (ra === 2) return number(a) - number(b);
  if ("timestampValue" in a && "timestampValue" in b)
    return Date.parse(a.timestampValue) - Date.parse(b.timestampValue);
  if ("stringValue" in a && "stringValue" in b)
    return compareStrings(a.stringValue, b.stringValue);
  if ("bytesValue" in a && "bytesValue" in b)
    return compareStrings(atob(a.bytesValue), atob(b.bytesValue));
  if ("referenceValue" in a && "referenceValue" in b)
    return comparePaths(a.referenceValue, b.referenceValue);
  return a === b || JSON.stringify(a) === JSON.stringify(b) ? 0 : 1;
}

function errorResponse(http: number, status: string, message: string) {
  return Response.json(
    { error: { code: http, message, status } },
    { status: http },
  );
}
class FakeError extends Error {
  constructor(
    readonly http: number,
    readonly status: string,
    message: string,
  ) {
    super(message);
  }
}

export class FakeFirestore {
  readonly docs = new Map<string, StoredDocument>();
  /** Every request received, in order. */
  readonly requests: FakeRequest[] = [];
  private transactions = new Map<string, TransactionState>();
  private tick = 0;
  private nextTransaction = 0;
  private readonly root: string;
  constructor(private readonly options: FakeFirestoreOptions = {}) {
    this.root = `projects/${options.projectId ?? "test"}/databases/${options.databaseId ?? "(default)"}/documents`;
  }

  /** The `fetch` to hand to the client. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const prefix = `/v1/${this.root}`;
    if (!url.pathname.startsWith(prefix))
      return errorResponse(404, "NOT_FOUND", "Unknown database");
    const rest = decodeURIComponent(url.pathname.slice(prefix.length));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const colon = method === "POST" ? rest.lastIndexOf(":") : -1;
    const action = colon >= 0 ? rest.slice(colon + 1) : "get";
    const path = (colon >= 0 ? rest.slice(0, colon) : rest).replace(/^\//, "");
    const request = { method, action, body };
    this.requests.push(request);
    const injected = this.options.intercept?.(request);
    if (injected) return injected;
    try {
      switch (action) {
        case "get":
          return this.handleGet(path, url.searchParams.get("transaction"));
        case "batchGet":
          return this.handleBatchGet(body);
        case "runQuery":
          return this.handleRunQuery(path, body);
        case "commit":
          return this.handleCommit(body);
        case "beginTransaction":
          return this.handleBegin();
        case "rollback":
          this.transactions.delete(body.transaction);
          return Response.json({});
        default:
          return errorResponse(400, "INVALID_ARGUMENT", "Unknown method");
      }
    } catch (error) {
      if (error instanceof FakeError)
        return errorResponse(error.http, error.status, error.message);
      throw error;
    }
  };

  private stamp(): string {
    const n = ++this.tick;
    const base = Date.UTC(2026, 0, 1) + Math.floor(n / 1000);
    return new Date(base)
      .toISOString()
      .replace(/Z$/, `${String(n % 1000).padStart(3, "0")}Z`);
  }
  private name(path: string): string {
    return `${this.root}/${path}`;
  }
  private render(path: string, doc: StoredDocument) {
    return {
      name: this.name(path),
      fields: structuredClone(doc.fields),
      createTime: doc.createTime,
      updateTime: doc.updateTime,
    };
  }
  private relative(name: string): string {
    if (!name.startsWith(`${this.root}/`)) throw new Error("Foreign document");
    return name.slice(this.root.length + 1);
  }
  private track(transaction: string | null | undefined, path: string) {
    if (!transaction) return;
    const state = this.transactions.get(transaction);
    if (!state)
      throw new FakeError(400, "INVALID_ARGUMENT", "Invalid transaction");
    if (!state.reads.has(path))
      state.reads.set(path, this.docs.get(path)?.updateTime ?? null);
  }

  private handleGet(path: string, transaction: string | null): Response {
    this.track(transaction, path);
    const doc = this.docs.get(path);
    if (!doc) return errorResponse(404, "NOT_FOUND", "Document not found");
    return Response.json(this.render(path, doc));
  }
  private handleBatchGet(body: {
    documents: string[];
    transaction?: string;
  }): Response {
    const readTime = this.stamp();
    return Response.json(
      body.documents.map((name) => {
        const path = this.relative(name);
        this.track(body.transaction, path);
        const doc = this.docs.get(path);
        return doc
          ? { found: this.render(path, doc), readTime }
          : { missing: name, readTime };
      }),
    );
  }
  private handleBegin(): Response {
    const id = btoa(`tx-${++this.nextTransaction}`);
    this.transactions.set(id, { reads: new Map(), queries: [] });
    return Response.json({ transaction: id });
  }

  private evaluate(
    parent: string,
    query: StructuredQuery,
  ): { path: string; doc: StoredDocument }[] {
    const collection = query.from[0]?.collectionId as string;
    const shape = shapeOfStructured(query);
    if (
      shape.range &&
      shape.orderBy[0] &&
      shape.orderBy[0].field !== shape.range
    )
      throw new FakeError(
        400,
        "INVALID_ARGUMENT",
        "Inequality filter field must be the first orderBy",
      );
    if (this.options.indexes && !isServed(shape, this.options.indexes))
      throw new FakeError(
        400,
        "FAILED_PRECONDITION",
        "The query requires an index",
      );
    const depth = (parent ? parent.split("/").length : 0) + 2;
    const base = parent ? `${parent}/${collection}/` : `${collection}/`;
    let rows = [...this.docs]
      .filter(
        ([path]) => path.startsWith(base) && path.split("/").length === depth,
      )
      .map(([path, doc]) => ({ path, doc }));
    const value = (
      row: { path: string; doc: StoredDocument },
      field: string,
    ) =>
      field === NAME_FIELD
        ? ({ referenceValue: this.name(row.path) } as Value)
        : row.doc.fields[field];
    const filters = query.where
      ? "compositeFilter" in query.where
        ? query.where.compositeFilter.filters.map((f) => f.fieldFilter)
        : [query.where.fieldFilter]
      : [];
    rows = rows.filter((row) =>
      filters.every((f) => {
        const actual = value(row, f.field.fieldPath);
        if (!actual) return false;
        if (typeRank(actual) !== typeRank(f.value)) return false;
        const delta = compareValues(actual, f.value);
        switch (f.op) {
          case "EQUAL":
            return delta === 0;
          case "LESS_THAN":
            return delta < 0;
          case "LESS_THAN_OR_EQUAL":
            return delta <= 0;
          case "GREATER_THAN":
            return delta > 0;
          default:
            return delta >= 0;
        }
      }),
    );
    const order = (query.orderBy ?? []).map((o) => ({
      field: o.field.fieldPath,
      sign: o.direction === "ASCENDING" ? 1 : -1,
    }));
    const nameSign = order.at(-1)?.sign ?? 1;
    rows = rows.filter((row) =>
      order.every((o) => value(row, o.field) !== undefined),
    );
    const compareRows = (
      a: { path: string; doc: StoredDocument },
      b: { path: string; doc: StoredDocument },
    ) => {
      for (const o of order) {
        const delta = compareValues(
          value(a, o.field) as Value,
          value(b, o.field) as Value,
        );
        if (delta) return o.sign * delta;
      }
      return nameSign * comparePaths(a.path, b.path);
    };
    rows.sort(compareRows);
    if (query.startAt) {
      const cursor = query.startAt.values;
      rows = rows.filter((row) => {
        for (let i = 0; i < order.length; i++) {
          const o = order[i] as (typeof order)[number];
          const delta =
            o.sign *
            compareValues(value(row, o.field) as Value, cursor[i] as Value);
          if (delta) return query.startAt?.before ? delta > 0 : delta > 0;
        }
        return false;
      });
    }
    return rows.slice(0, query.limit ?? rows.length);
  }
  private handleRunQuery(
    parentPath: string,
    body: { structuredQuery: StructuredQuery; transaction?: string },
  ): Response {
    const rows = this.evaluate(parentPath, body.structuredQuery);
    if (body.transaction) {
      const state = this.transactions.get(body.transaction);
      if (!state)
        throw new FakeError(400, "INVALID_ARGUMENT", "Invalid transaction");
      state.queries.push({
        parent: parentPath,
        query: body.structuredQuery,
        signature: JSON.stringify(rows.map((r) => [r.path, r.doc.updateTime])),
      });
      for (const row of rows)
        if (!state.reads.has(row.path))
          state.reads.set(row.path, row.doc.updateTime);
    }
    const readTime = this.stamp();
    return Response.json(
      rows.length
        ? rows.map((r) => ({ document: this.render(r.path, r.doc), readTime }))
        : [{ readTime }],
    );
  }

  private handleCommit(body: {
    writes: Record<string, unknown>[];
    transaction?: string;
  }): Response {
    if (body.writes.length > 500)
      throw new FakeError(
        400,
        "INVALID_ARGUMENT",
        "Too many writes in a commit",
      );
    if (body.transaction) {
      const state = this.transactions.get(body.transaction);
      if (!state)
        throw new FakeError(400, "INVALID_ARGUMENT", "Invalid transaction");
      this.transactions.delete(body.transaction);
      for (const [path, seen] of state.reads)
        if ((this.docs.get(path)?.updateTime ?? null) !== seen)
          throw new FakeError(409, "ABORTED", "Transaction aborted");
      for (const q of state.queries) {
        const now = JSON.stringify(
          this.evaluate(q.parent, q.query).map((r) => [
            r.path,
            r.doc.updateTime,
          ]),
        );
        if (now !== q.signature)
          throw new FakeError(409, "ABORTED", "Transaction aborted");
      }
    }
    const staged = new Map(this.docs);
    const updateTime = this.stamp();
    const writeResults: { updateTime: string; transformResults?: Value[] }[] =
      [];
    for (const write of body.writes) {
      const precondition = write.currentDocument as
        | { exists?: boolean; updateTime?: string }
        | undefined;
      const path = this.relative(
        (write.delete ?? (write.update as { name: string }).name) as string,
      );
      const existing = staged.get(path);
      if (precondition?.exists === false && existing)
        throw new FakeError(409, "ALREADY_EXISTS", "Document already exists");
      if (precondition?.exists === true && !existing)
        throw new FakeError(404, "NOT_FOUND", "Document not found");
      if (
        precondition?.updateTime !== undefined &&
        existing?.updateTime !== precondition.updateTime
      )
        throw new FakeError(
          400,
          "FAILED_PRECONDITION",
          "Document update time mismatch",
        );
      if (write.delete) {
        staged.delete(path);
        writeResults.push({ updateTime });
        continue;
      }
      const update = write.update as { fields?: Fields };
      const mask = (write.updateMask as { fieldPaths: string[] } | undefined)
        ?.fieldPaths;
      const fields: Fields = mask
        ? { ...(existing?.fields ?? {}) }
        : { ...(update.fields ?? {}) };
      for (const field of mask ?? []) {
        const next = update.fields?.[field];
        if (next) fields[field] = next;
        else delete fields[field];
      }
      const transformResults: Value[] = [];
      for (const transform of (write.updateTransforms ?? []) as {
        fieldPath: string;
        increment: Value;
      }[]) {
        const current = fields[transform.fieldPath];
        const by = number(transform.increment);
        const next: Value =
          current && "integerValue" in current
            ? { integerValue: String(Number(current.integerValue) + by) }
            : current && "doubleValue" in current
              ? { doubleValue: number(current) + by }
              : { integerValue: String(by) };
        fields[transform.fieldPath] = next;
        transformResults.push(next);
      }
      staged.set(path, {
        fields,
        createTime: existing?.createTime ?? updateTime,
        updateTime,
      });
      writeResults.push({ updateTime, transformResults });
    }
    this.docs.clear();
    for (const [path, doc] of staged) this.docs.set(path, doc);
    return Response.json({ writeResults, commitTime: updateTime });
  }
}
