import { GcpAuthError } from "./errors.js";

export type Fetch = typeof fetch;
export type Clock = () => number;
/** Default OAuth scope for GCS and most data-plane APIs used by errtraq adapters. */
export const CLOUD_PLATFORM_SCOPE =
  "https://www.googleapis.com/auth/cloud-platform";

/**
 * A source of Google credentials. An empty access token means "send no Authorization header"
 * (emulators only).
 */
export interface TokenSource {
  getAccessToken(scopes?: readonly string[]): Promise<string>;
  getIdToken(audience: string): Promise<string>;
}
/** Signs bytes as a service account (RSA PKCS#1 v1.5 with SHA-256). */
export interface BlobSigner {
  readonly email: string | (() => Promise<string>);
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

export interface CachedToken {
  value: string;
  /** Absolute expiry in epoch milliseconds. */
  expiresAt: number;
}
/**
 * Caches tokens per key. A token is reused until `skewMs` before its expiry; concurrent misses
 * share one refresh; failures are never cached.
 */
export class TokenCache {
  private readonly tokens = new Map<string, CachedToken>();
  private readonly inflight = new Map<string, Promise<string>>();
  constructor(
    private readonly clock: Clock,
    private readonly skewMs = 60_000,
  ) {}
  get(key: string, refresh: () => Promise<CachedToken>): Promise<string> {
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - this.skewMs > this.clock())
      return Promise.resolve(cached.value);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = (async () => {
      try {
        const token = await refresh();
        this.tokens.set(key, token);
        return token.value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run);
    return run;
  }
}
export function scopeKey(scopes: readonly string[] | undefined): string {
  return [...new Set(scopes?.length ? scopes : [CLOUD_PLATFORM_SCOPE])]
    .sort()
    .join(" ");
}
/** A fixed access token (tests, pre-minted tokens). */
export function staticTokenSource(
  accessToken: string,
  idToken?: string,
): TokenSource {
  return {
    getAccessToken: async () => accessToken,
    getIdToken: async () => {
      if (idToken === undefined)
        throw new GcpAuthError(
          "Static token source has no ID token",
          "unsupported",
        );
      return idToken;
    },
  };
}
/** Emulators accept unauthenticated requests: no Authorization header is sent. */
export function noAuthTokenSource(): TokenSource {
  return staticTokenSource("");
}
