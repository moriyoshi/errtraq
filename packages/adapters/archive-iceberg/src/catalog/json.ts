/**
 * Iceberg ids (snapshot ids, in particular) are 64-bit integers and frequently exceed
 * `Number.MAX_SAFE_INTEGER`; `JSON.parse` would round them. These helpers keep them exact.
 */

const MAX_SAFE = String(Number.MAX_SAFE_INTEGER);

function isUnsafeInteger(digits: string): boolean {
  const unsigned = digits.startsWith("-") ? digits.slice(1) : digits;
  if (unsigned.length !== MAX_SAFE.length)
    return unsigned.length > MAX_SAFE.length;
  return unsigned > MAX_SAFE;
}

/**
 * Parse JSON, turning every integer literal beyond the safe range into a decimal string. A
 * literal inside a string is never touched. Safe integers stay numbers, so a 64-bit id field may
 * arrive as either type; use `longString` to normalise.
 */
export function parseJsonPreservingLongs(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    if (c === '"') {
      let j = i + 1;
      while (j < n && text.charAt(j) !== '"')
        j += text.charAt(j) === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(text.charAt(j))) j++;
      const token = text.slice(i, j);
      out +=
        /^-?\d+$/.test(token) && isUnsafeInteger(token) ? `"${token}"` : token;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

/** A 64-bit integer carried exactly to the wire. */
export class Long {
  readonly digits: string;
  constructor(value: string | number | bigint) {
    const digits = typeof value === "string" ? value : value.toString();
    if (
      !/^-?\d+$/.test(digits) ||
      (typeof value === "number" && !Number.isSafeInteger(value))
    )
      throw new TypeError("Not a safe 64-bit integer literal");
    this.digits = digits;
  }
  toJSON(): string {
    return `${LONG_SENTINEL}${this.digits}`;
  }
}

/**
 * Marks a `Long` in the intermediate JSON. It starts with U+0000, which `JSON.stringify` always
 * escapes as `\u0000`, so no ordinary string value (a table property, say) can collide with it.
 */
const LONG_SENTINEL = "\u0000errtraq-long:";

/** `JSON.stringify` that writes `Long` values as bare integer literals. */
export function stringifyWithLongs(value: unknown): string {
  return JSON.stringify(value).replace(/"\\u0000errtraq-long:(-?\d+)"/g, "$1");
}

/** Normalise an id that arrived as a number or a string to its decimal string. */
export function longString(value: string | number | bigint): string {
  return new Long(value).digits;
}
