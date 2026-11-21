import type { Cursor } from "./domain.js";
import { InvalidCursorError } from "./errors.js";

/** Limits must be positive safe integers; adapters reject invalid values rather than clamp. */
export function pageLimit(value?: number): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000)
    throw new InvalidCursorError("Invalid page limit");
  return value;
}
/** Encode a cursor with a query scope so it cannot be reused with different filters. */
export function encodeCursor(scope: string, keys: (string | number)[]): Cursor {
  const bytes = new TextEncoder().encode(JSON.stringify([scope, keys]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const cursor = `v1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
  if (cursor.length > 8192)
    throw new InvalidCursorError("Cursor exceeds maximum size");
  return cursor as Cursor;
}
export function decodeCursor(
  cursor: Cursor | undefined,
  scope: string,
): (string | number)[] | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (!/^v1\.[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 8192)
      throw new Error();
    const binary = atob(
      cursor.slice(3).replaceAll("-", "+").replaceAll("_", "/"),
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      value[0] !== scope ||
      !Array.isArray(value[1]) ||
      !value[1].every(
        (v: unknown) =>
          typeof v === "string" ||
          (typeof v === "number" && Number.isSafeInteger(v)),
      )
    )
      throw new Error();
    if (encodeCursor(scope, value[1]) !== cursor) throw new Error();
    return value[1] as (string | number)[];
  } catch {
    throw new InvalidCursorError("Invalid cursor");
  }
}

/** Scope a source-local event cursor to all query filters and the federation boundary. */
export function eventCursorScope(q: import("./ports.js").EventQuery): string {
  return JSON.stringify([
    "events",
    q.projectId,
    q.issueId ?? null,
    q.from ?? null,
    q.to ?? null,
    q.after ?? null,
    q.order ?? "desc",
  ]);
}
