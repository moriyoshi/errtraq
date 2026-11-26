/** PKCE (RFC 7636) and random values for `state` and `nonce`, from WebCrypto only. */

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** `byteLength` random bytes as base64url; 48 bytes give a 64 character string. */
export function randomString(byteLength = 48): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** A code verifier: 43 to 128 unreserved characters (RFC 7636 section 4.1). */
export function createVerifier(): string {
  return randomString(48);
}

/** S256 challenge: BASE64URL(SHA-256(ASCII(verifier))). */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}
