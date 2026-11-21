import type { IdGen } from "./ports.js";

/** Cryptographically random identifiers suitable for production. */
export class WebCryptoIdGen implements IdGen {
  next(): string {
    return crypto.randomUUID();
  }
}
export function generatePublicKey(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
export function generateEventId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
export function generateApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `errtraq_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
export async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Canonical manifest digest: UTF-8 JSON of distinct debug IDs in byte order. */
export async function bundleDebugIdsDigest(
  ids: readonly string[],
): Promise<string> {
  const encoder = new TextEncoder();
  const compare = (a: string, b: string) => {
    const x = encoder.encode(a),
      y = encoder.encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d) return d;
    }
    return x.length - y.length;
  };
  const canonical = [...new Set(ids)].sort(compare);
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(JSON.stringify(canonical)),
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
