/** An invalid envelope or event is permanent and must not be retried. */
export class InvalidEnvelopeError extends Error {
  override name = "InvalidEnvelopeError";
}
export interface EnvelopeItem {
  headers: Record<string, unknown>;
  payload: Uint8Array;
}
export interface Envelope {
  headers: Record<string, unknown>;
  items: EnvelopeItem[];
}
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
function parseObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Expected object");
    return value as Record<string, unknown>;
  } catch {
    throw new InvalidEnvelopeError("Invalid JSON object");
  }
}
/** Parse newline headers and either byte-length-delimited or newline-terminated items. */
export function parseEnvelope(bytes: Uint8Array): Envelope {
  let pos = 0;
  function line(): Uint8Array {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 10) pos++;
    let end = pos;
    if (pos < bytes.length) pos++;
    if (end > start && bytes[end - 1] === 13) end--;
    return bytes.subarray(start, end);
  }
  if (!bytes.length) throw new InvalidEnvelopeError("Empty envelope");
  const headers = parseObject(line());
  const items: EnvelopeItem[] = [];
  while (pos < bytes.length) {
    if (bytes[pos] === 10) {
      pos++;
      continue;
    }
    const itemHeaders = parseObject(line());
    if (typeof itemHeaders.type !== "string" || !itemHeaders.type)
      throw new InvalidEnvelopeError("Missing item type");
    let payload: Uint8Array;
    if (itemHeaders.length !== undefined) {
      const length = itemHeaders.length;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        pos + length > bytes.length
      )
        throw new InvalidEnvelopeError("Invalid item length");
      payload = bytes.slice(pos, pos + length);
      pos += length;
      if (pos < bytes.length && bytes[pos] === 13 && bytes[pos + 1] === 10)
        pos += 2;
      else if (pos < bytes.length && bytes[pos] === 10) pos++;
      else if (pos < bytes.length)
        throw new InvalidEnvelopeError("Missing item delimiter");
    } else payload = line().slice();
    items.push({ headers: itemHeaders, payload });
  }
  return { headers, items };
}
/** Wrap a legacy store payload in an equivalent envelope. */
export function wrapStorePayload(
  payload: Uint8Array,
  eventId: string,
): Uint8Array {
  const head = encoder.encode(
    `${JSON.stringify({ event_id: eventId })}\n${JSON.stringify({ type: "event", length: payload.length })}\n`,
  );
  const result = new Uint8Array(head.length + payload.length);
  result.set(head);
  result.set(payload, head.length);
  return result;
}
export function parseEventPayload(bytes: Uint8Array): Record<string, unknown> {
  return parseObject(bytes);
}
/** Read the public DSN key from Sentry auth or query string. */
export function parseDsnKey(
  header: string | null | undefined,
  query: string | null | undefined,
): string | null {
  if (query) return query;
  if (!header || !/^Sentry\s+/i.test(header)) return null;
  const entry = header
    .replace(/^Sentry\s+/i, "")
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("sentry_key="));
  return entry?.slice("sentry_key=".length).replace(/^"|"$/g, "") || null;
}
