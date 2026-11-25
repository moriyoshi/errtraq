import type { Value } from "./value.js";

export type Direction = "ASC" | "DESC";
export type FilterOp =
  | "EQUAL"
  | "LESS_THAN"
  | "LESS_THAN_OR_EQUAL"
  | "GREATER_THAN"
  | "GREATER_THAN_OR_EQUAL";
export interface Filter {
  field: string;
  op: FilterOp;
  value: Value;
}
export interface Order {
  field: string;
  direction: Direction;
}
/** A cursor position value; `docPath` stands for the `__name__` document reference. */
export type CursorValue = Value | { docPath: string };
/** A query over one collection (`parent` is "" for a top-level collection). */
export interface Query {
  parent: string;
  collection: string;
  where?: Filter[];
  orderBy?: Order[];
  /** One value per explicit `orderBy` entry, exclusive. */
  startAfter?: CursorValue[];
  limit?: number;
}

/** The wire form of a structured query (only the parts this client emits). */
export interface StructuredQuery {
  from: { collectionId: string }[];
  where?:
    | { fieldFilter: WireFilter }
    | {
        compositeFilter: { op: "AND"; filters: { fieldFilter: WireFilter }[] };
      };
  orderBy?: {
    field: { fieldPath: string };
    direction: "ASCENDING" | "DESCENDING";
  }[];
  startAt?: { values: Value[]; before: boolean };
  limit?: number;
}
interface WireFilter {
  field: { fieldPath: string };
  op: FilterOp;
  value: Value;
}

export const NAME_FIELD = "__name__";

export function toStructuredQuery(
  query: Query,
  documentName: (path: string) => string,
): StructuredQuery {
  const structured: StructuredQuery = {
    from: [{ collectionId: query.collection }],
  };
  const filters = (query.where ?? []).map((f) => ({
    fieldFilter: {
      field: { fieldPath: f.field },
      op: f.op,
      value: f.value,
    },
  }));
  if (filters.length === 1 && filters[0])
    structured.where = { fieldFilter: filters[0].fieldFilter };
  else if (filters.length > 1)
    structured.where = { compositeFilter: { op: "AND", filters } };
  const orderBy = query.orderBy ?? [];
  if (orderBy.length)
    structured.orderBy = orderBy.map((o) => ({
      field: { fieldPath: o.field },
      direction: o.direction === "ASC" ? "ASCENDING" : "DESCENDING",
    }));
  if (query.startAfter) {
    if (query.startAfter.length !== orderBy.length)
      throw new RangeError("Cursor must have one value per orderBy entry");
    structured.startAt = {
      before: false,
      values: query.startAfter.map((v) =>
        "docPath" in v ? { referenceValue: documentName(v.docPath) } : v,
      ),
    };
  }
  if (query.limit !== undefined) structured.limit = query.limit;
  return structured;
}

export interface IndexField {
  field: string;
  direction: Direction;
}
/** A composite index; a trailing `__name__` entry is implied when absent. */
export interface CompositeIndex {
  collection: string;
  fields: IndexField[];
}
export interface QueryShape {
  collection: string;
  equality: string[];
  /** The inequality field, when the query has range filters. */
  range?: string;
  /** Explicit orderBy as written. */
  orderBy: IndexField[];
}

export function shapeOfStructured(sq: StructuredQuery): QueryShape {
  const filters = sq.where
    ? "compositeFilter" in sq.where
      ? sq.where.compositeFilter.filters.map((f) => f.fieldFilter)
      : [sq.where.fieldFilter]
    : [];
  const equality = [
    ...new Set(
      filters.filter((f) => f.op === "EQUAL").map((f) => f.field.fieldPath),
    ),
  ].sort();
  const ranges = [
    ...new Set(
      filters.filter((f) => f.op !== "EQUAL").map((f) => f.field.fieldPath),
    ),
  ];
  if (ranges.length > 1)
    throw new RangeError("Firestore allows one inequality field per query");
  return {
    collection: sq.from[0]?.collectionId ?? "",
    equality,
    ...(ranges[0] ? { range: ranges[0] } : {}),
    orderBy: (sq.orderBy ?? []).map((o) => ({
      field: o.field.fieldPath,
      direction: o.direction === "ASCENDING" ? "ASC" : "DESC",
    })),
  };
}
export function shapeOfQuery(query: Query): QueryShape {
  return shapeOfStructured(toStructuredQuery(query, (p) => p));
}

/** Explicit ordering with the range field first and `__name__` made explicit. */
function effectiveOrder(shape: QueryShape): IndexField[] {
  const order = [...shape.orderBy];
  const { range } = shape;
  if (range && order[0]?.field !== range)
    order.unshift({ field: range, direction: "ASC" });
  if (!order.some((o) => o.field === NAME_FIELD))
    order.push({
      field: NAME_FIELD,
      direction: order.at(-1)?.direction ?? "ASC",
    });
  return order;
}

/**
 * Whether the query is served by automatic single-field indexes or one of `indexes`. This is a
 * deliberately conservative model of Firestore's rules (verified against real Firestore in G8):
 * automatic indexes serve a query with no orderBy and any number of equalities (index merge),
 * one equality ordered by `__name__` only, and no equality ordered by one field with `__name__`
 * in the same direction. Anything else needs a composite index whose leading fields are the
 * equality fields, followed by the ordered fields, with the trailing `__name__` direction equal
 * to the last ordered field's.
 */
export function isServed(
  shape: QueryShape,
  indexes: readonly CompositeIndex[],
): boolean {
  const order = effectiveOrder(shape);
  const name = order.at(-1) as IndexField;
  const ordered = order.slice(0, -1);
  const eq = shape.equality;
  if (shape.orderBy.length === 0 && !shape.range) return true;
  if (ordered.length === 0 && eq.length <= 1) return true;
  if (
    eq.length === 0 &&
    ordered.length === 1 &&
    ordered[0]?.direction === name.direction
  )
    return true;
  return indexes.some((index) => {
    if (index.collection !== shape.collection) return false;
    const fields = [...index.fields];
    const last = fields.at(-1);
    const indexName =
      last?.field === NAME_FIELD
        ? (fields.pop() as IndexField)
        : { field: NAME_FIELD, direction: last?.direction ?? "ASC" };
    if (indexName.direction !== name.direction) return false;
    if (fields.length !== eq.length + ordered.length) return false;
    const lead = fields.slice(0, eq.length).map((f) => f.field);
    if ([...lead].sort().join("\0") !== [...eq].sort().join("\0")) return false;
    return ordered.every((o, i) => {
      const f = fields[eq.length + i];
      return f?.field === o.field && f.direction === o.direction;
    });
  });
}

/** Human-readable index definition a query needs, for configuration errors. */
export function describeRequiredIndex(shape: QueryShape): string {
  const order = effectiveOrder(shape);
  const fields = [
    ...shape.equality.map((field) => ({ field, direction: "ASC" })),
    ...order,
  ];
  return `${shape.collection}: ${fields.map((f) => `${f.field} ${f.direction}`).join(", ")}`;
}
