import {
  base64Decode,
  base64UrlEncode,
  base64UrlEncodeText,
} from "./encoding.js";
import { GcpAuthError } from "./errors.js";

export const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}
function parseObject(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    new TextDecoder().decode(base64Decode(segment)),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("JWT segment is not an object");
  return value as Record<string, unknown>;
}
/** Parse a compact JWT without verifying it. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part))
    throw new TypeError("Malformed JWT");
  const [header, claims, signature] = parts as [string, string, string];
  return {
    header: parseObject(header),
    claims: parseObject(claims),
    signingInput: new TextEncoder().encode(`${header}.${claims}`),
    signature: base64Decode(signature),
  };
}
/** Sign a compact RS256 JWT with a WebCrypto private key. */
export async function signJwt(
  key: CryptoKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  const input = `${base64UrlEncodeText(JSON.stringify({ ...header, alg: "RS256", typ: "JWT" }))}.${base64UrlEncodeText(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    RS256,
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}
/** Expiry (epoch ms) of a JWT, taken from its `exp` claim. */
export function jwtExpiry(token: string): number {
  let exp: unknown;
  try {
    exp = decodeJwt(token).claims.exp;
  } catch {
    throw new GcpAuthError("Received a malformed ID token", "bad_response");
  }
  if (typeof exp !== "number" || !Number.isFinite(exp))
    throw new GcpAuthError("ID token has no expiry", "bad_response");
  return exp * 1000;
}
