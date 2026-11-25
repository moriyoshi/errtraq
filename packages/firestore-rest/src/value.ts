/** Firestore REST `Value` model and the plain-JS mapping used by the adapters. */

export type Value =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number | string }
  | { timestampValue: string }
  | { stringValue: string }
  | { bytesValue: string }
  | { referenceValue: string }
  | { mapValue: { fields?: Fields } }
  | { arrayValue: { values?: Value[] } };
export type Fields = Record<string, Value>;

/** A Firestore timestamp field (the TTL policy needs this type, plain strings do not qualify). */
export class FsTimestamp {
  constructor(readonly iso: string) {
    if (Number.isNaN(Date.parse(iso)))
      throw new RangeError("Invalid Firestore timestamp");
  }
}
/** A reference to a document, relative to the database documents root. */
export class FsReference {
  constructor(readonly path: string) {}
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode one JS value; `undefined` is not representable (callers omit such fields). */
export function encodeValue(value: unknown): Value {
  if (value === null) return { nullValue: null };
  switch (typeof value) {
    case "boolean":
      return { booleanValue: value };
    case "string":
      return { stringValue: value };
    case "number":
      if (!Number.isFinite(value))
        throw new RangeError("Firestore values must be finite numbers");
      return Number.isSafeInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value };
    case "object":
      break;
    default:
      throw new TypeError(`Unsupported Firestore value type ${typeof value}`);
  }
  if (value instanceof FsTimestamp) return { timestampValue: value.iso };
  if (value instanceof FsReference) return { referenceValue: value.path };
  if (value instanceof Uint8Array) return { bytesValue: bytesToBase64(value) };
  if (Array.isArray(value))
    return { arrayValue: { values: value.map(encodeValue) } };
  return {
    mapValue: { fields: encodeFields(value as Record<string, unknown>) },
  };
}
/** Fields whose value is `undefined` are dropped. */
export function encodeFields(object: Record<string, unknown>): Fields {
  const fields: Fields = {};
  for (const [name, value] of Object.entries(object))
    if (value !== undefined) fields[name] = encodeValue(value);
  return fields;
}

export function decodeValue(value: Value): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) {
    const number = Number(value.integerValue);
    if (!Number.isSafeInteger(number))
      throw new RangeError("Firestore integer exceeds the safe range");
    return number;
  }
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return new FsTimestamp(value.timestampValue);
  if ("stringValue" in value) return value.stringValue;
  if ("bytesValue" in value) return base64ToBytes(value.bytesValue);
  if ("referenceValue" in value) return new FsReference(value.referenceValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
  if ("arrayValue" in value)
    return (value.arrayValue.values ?? []).map(decodeValue);
  throw new TypeError("Unsupported Firestore value");
}
export function decodeFields(fields: Fields): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields))
    result[name] = decodeValue(value);
  return result;
}

const encoder = new TextEncoder();
/**
 * Stored size of a document per the Firestore documentation: name size plus 16, then for each
 * field the name size plus 1 and the value size. Used for the client-side 1 MiB guard.
 */
export function valueSize(value: Value): number {
  if ("nullValue" in value) return 1;
  if ("booleanValue" in value) return 1;
  if ("integerValue" in value || "doubleValue" in value) return 8;
  if ("timestampValue" in value) return 16;
  if ("stringValue" in value)
    return encoder.encode(value.stringValue).length + 1;
  if ("bytesValue" in value)
    return Math.floor((value.bytesValue.length * 3) / 4);
  if ("referenceValue" in value)
    return encoder.encode(value.referenceValue).length + 16;
  if ("mapValue" in value) return fieldsSize(value.mapValue.fields ?? {}) + 32;
  return (
    (value.arrayValue.values ?? []).reduce((n, v) => n + valueSize(v), 0) + 32
  );
}
function fieldsSize(fields: Fields): number {
  let bytes = 0;
  for (const [name, value] of Object.entries(fields))
    bytes += encoder.encode(name).length + 1 + valueSize(value);
  return bytes;
}
export function documentSize(path: string, fields: Fields): number {
  return encoder.encode(path).length + 16 + fieldsSize(fields);
}
/** The maximum document size Firestore accepts. */
export const MAX_DOCUMENT_BYTES = 1_048_576;
