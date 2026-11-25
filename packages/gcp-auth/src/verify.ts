import { GcpTokenVerificationError } from "./errors.js";
import { decodeJwt, RS256 } from "./jwt.js";
import type { Clock, Fetch } from "./token-source.js";

export const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;

export interface VerifyIdTokenOptions {
  /** Required `aud` claim (the push subscription's configured audience). */
  audience: string;
  issuers?: readonly string[];
  /** When set, the `email` claim must equal this service account email... */
  email?: string;
  /** ...and `email_verified` must be true (default true whenever `email` is set). */
  requireEmailVerified?: boolean;
  /** Tolerated clock skew for `exp`, `iat` and `nbf`. Default 60 seconds. */
  clockSkewSec?: number;
  keys?: GoogleKeyStore;
  clock?: Clock;
}
export interface GoogleIdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat?: number;
  email?: string;
  email_verified?: boolean;
  [claim: string]: unknown;
}

/** Fetches and caches Google's signing keys, refetching at most once per interval on an unknown kid. */
export class GoogleKeyStore {
  private keys = new Map<string, CryptoKey>();
  private expiresAt = 0;
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private inflight?: Promise<void>;
  private readonly fetcher: Fetch;
  private readonly clock: Clock;
  constructor(
    private readonly options: {
      uri?: string;
      fetch?: Fetch;
      clock?: Clock;
      /** Minimum gap between refetches triggered by unknown key ids. Default 60 seconds. */
      minRefetchMs?: number;
      /** Cache lifetime when the response has no `max-age`. Default one hour. */
      defaultMaxAgeSec?: number;
    } = {},
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
  }
  private refresh(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        const response = await this.fetcher(
          this.options.uri ?? GOOGLE_JWKS_URI,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new GcpTokenVerificationError("Signing keys are unavailable");
        }
        const body = (await response.json()) as { keys?: unknown };
        if (!Array.isArray(body.keys)) throw new TypeError("no keys");
        const next = new Map<string, CryptoKey>();
        for (const jwk of body.keys as (JsonWebKey & { kid?: string })[]) {
          if (jwk.kty !== "RSA" || !jwk.kid) continue;
          next.set(
            jwk.kid,
            await crypto.subtle.importKey(
              "jwk",
              { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
              RS256,
              false,
              ["verify"],
            ),
          );
        }
        const maxAge = Number(
          /max-age=(\d+)/.exec(
            response.headers.get("cache-control") ?? "",
          )?.[1],
        );
        this.keys = next;
        this.fetchedAt = this.clock();
        this.expiresAt =
          this.fetchedAt +
          1000 *
            (Number.isFinite(maxAge)
              ? maxAge
              : (this.options.defaultMaxAgeSec ?? 3600));
      } catch (error) {
        if (error instanceof GcpTokenVerificationError) throw error;
        throw new GcpTokenVerificationError("Signing keys could not be loaded");
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
  async get(kid: string): Promise<CryptoKey | undefined> {
    const now = this.clock();
    if (now >= this.expiresAt) await this.refresh();
    let key = this.keys.get(kid);
    if (
      !key &&
      this.clock() - this.fetchedAt >= (this.options.minRefetchMs ?? 60_000)
    ) {
      await this.refresh();
      key = this.keys.get(kid);
    }
    return key;
  }
}
let defaultKeys: GoogleKeyStore | undefined;

/**
 * Verify a Google-signed OIDC ID token (the Pub/Sub push `Authorization: Bearer` token): RS256
 * signature against Google's JWKS, `iss`, `aud`, `exp`/`nbf`, and optionally the service account
 * `email` with `email_verified`. Throws `GcpTokenVerificationError` with a non-revealing message.
 */
export async function verifyGoogleIdToken(
  token: string,
  options: VerifyIdTokenOptions,
): Promise<GoogleIdTokenClaims> {
  let decoded: ReturnType<typeof decodeJwt>;
  try {
    decoded = decodeJwt(token);
  } catch {
    throw new GcpTokenVerificationError("Malformed ID token");
  }
  const { header, claims } = decoded;
  if (header.alg !== "RS256" || typeof header.kid !== "string")
    throw new GcpTokenVerificationError("Unsupported ID token algorithm");
  defaultKeys ??= new GoogleKeyStore();
  const keys = options.keys ?? defaultKeys;
  const key = await keys.get(header.kid);
  if (!key) throw new GcpTokenVerificationError("Unknown signing key");
  const valid = await crypto.subtle.verify(
    RS256,
    key,
    decoded.signature,
    decoded.signingInput,
  );
  if (!valid) throw new GcpTokenVerificationError("Invalid ID token signature");
  const skew = options.clockSkewSec ?? 60;
  const now = (options.clock ?? Date.now)() / 1000;
  if (
    typeof claims.iss !== "string" ||
    !(options.issuers ?? GOOGLE_ISSUERS).includes(claims.iss)
  )
    throw new GcpTokenVerificationError("Unexpected ID token issuer");
  const aud = claims.aud;
  if (
    aud !== options.audience &&
    !(Array.isArray(aud) && aud.includes(options.audience))
  )
    throw new GcpTokenVerificationError("Unexpected ID token audience");
  if (typeof claims.exp !== "number" || claims.exp + skew <= now)
    throw new GcpTokenVerificationError("ID token expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now)
    throw new GcpTokenVerificationError("ID token not yet valid");
  if (typeof claims.iat === "number" && claims.iat - skew > now)
    throw new GcpTokenVerificationError("ID token issued in the future");
  if (typeof claims.sub !== "string" || !claims.sub)
    throw new GcpTokenVerificationError("ID token has no subject");
  if (options.email !== undefined) {
    if (claims.email !== options.email)
      throw new GcpTokenVerificationError("Unexpected ID token email");
    if (
      options.requireEmailVerified !== false &&
      claims.email_verified !== true
    )
      throw new GcpTokenVerificationError("ID token email is not verified");
  }
  return claims as GoogleIdTokenClaims;
}
