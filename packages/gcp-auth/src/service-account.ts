import { pemToDer } from "./encoding.js";
import { GcpAuthError } from "./errors.js";
import { jwtExpiry, RS256, signJwt } from "./jwt.js";
import {
  type BlobSigner,
  type Clock,
  type Fetch,
  scopeKey,
  TokenCache,
  type TokenSource,
} from "./token-source.js";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}
export interface ServiceAccountOptions {
  /** The key JSON text (or parsed object). Secret material: pass it in, never log it. */
  key: string | ServiceAccountKey;
  fetch?: Fetch;
  clock?: Clock;
  skewMs?: number;
  requestTimeoutMs?: number;
  /** Override the token endpoint (tests, emulators). Defaults to the key's `token_uri`. */
  tokenUri?: string;
}
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_LIFETIME_SEC = 3600;

export function parseServiceAccountKey(
  input: string | ServiceAccountKey,
): ServiceAccountKey {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new GcpAuthError(
        "Service account key is not valid JSON",
        "bad_key",
      );
    }
  }
  const key = value as Partial<ServiceAccountKey> & { type?: unknown };
  if (
    !key ||
    typeof key !== "object" ||
    typeof key.client_email !== "string" ||
    !key.client_email ||
    typeof key.private_key !== "string" ||
    (key.type !== undefined && key.type !== "service_account")
  )
    throw new GcpAuthError(
      "Service account key must contain client_email and private_key",
      "bad_key",
    );
  return key as ServiceAccountKey;
}

/**
 * Service account JSON key to OAuth access tokens (JWT bearer grant, RS256 via WebCrypto) and
 * ID tokens (`target_audience` grant). Also a local `BlobSigner`, because GCS V4 signatures are
 * plain RSA-SHA256 over the string to sign.
 */
export class ServiceAccountTokenSource implements TokenSource, BlobSigner {
  readonly email: string;
  private readonly key: ServiceAccountKey;
  private readonly tokenUri: string;
  private readonly fetcher: Fetch;
  private readonly clock: Clock;
  private readonly cache: TokenCache;
  private readonly timeoutMs: number;
  private privateKey?: Promise<CryptoKey>;
  constructor(options: ServiceAccountOptions) {
    this.key = parseServiceAccountKey(options.key);
    this.email = this.key.client_email;
    this.tokenUri = options.tokenUri ?? this.key.token_uri ?? DEFAULT_TOKEN_URI;
    const uri = new URL(this.tokenUri);
    if (uri.protocol !== "https:" && !options.tokenUri)
      throw new GcpAuthError("Token URI must be https", "bad_key");
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.cache = new TokenCache(this.clock, options.skewMs);
    this.timeoutMs = options.requestTimeoutMs ?? 10_000;
  }
  private importKey(): Promise<CryptoKey> {
    this.privateKey ??= crypto.subtle
      .importKey("pkcs8", pemToDer(this.key.private_key), RS256, false, [
        "sign",
      ])
      .catch(() => {
        this.privateKey = undefined;
        throw new GcpAuthError(
          "Service account private key could not be imported",
          "bad_key",
        );
      });
    return this.privateKey;
  }
  async sign(payload: Uint8Array): Promise<Uint8Array> {
    const key = await this.importKey();
    return new Uint8Array(
      await crypto.subtle.sign(RS256, key, payload as Uint8Array<ArrayBuffer>),
    );
  }
  private async grant(extra: Record<string, unknown>): Promise<{
    access_token?: unknown;
    id_token?: unknown;
    expires_in?: unknown;
  }> {
    const issuedAt = Math.floor(this.clock() / 1000);
    const assertion = await signJwt(
      await this.importKey(),
      this.key.private_key_id ? { kid: this.key.private_key_id } : {},
      {
        iss: this.key.client_email,
        aud: this.tokenUri,
        iat: issuedAt,
        exp: issuedAt + JWT_LIFETIME_SEC,
        ...extra,
      },
    );
    let response: Response;
    try {
      response = await this.fetcher(this.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GcpAuthError("Token endpoint is unreachable", "unavailable");
    }
    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok || !body) {
      const oauth = typeof body?.error === "string" ? `, ${body.error}` : "";
      throw new GcpAuthError(
        `Token request failed (${response.status}${oauth})`,
        response.status >= 500 || response.status === 429
          ? "unavailable"
          : "denied",
        response.status,
      );
    }
    return body;
  }
  getAccessToken(scopes?: readonly string[]): Promise<string> {
    const scope = scopeKey(scopes);
    return this.cache.get(`access:${scope}`, async () => {
      const body = await this.grant({ scope });
      if (
        typeof body.access_token !== "string" ||
        !body.access_token ||
        typeof body.expires_in !== "number"
      )
        throw new GcpAuthError("Malformed token response", "bad_response");
      return {
        value: body.access_token,
        expiresAt: this.clock() + body.expires_in * 1000,
      };
    });
  }
  getIdToken(audience: string): Promise<string> {
    if (!audience) throw new TypeError("ID token audience is required");
    return this.cache.get(`id:${audience}`, async () => {
      const body = await this.grant({ target_audience: audience });
      if (typeof body.id_token !== "string" || !body.id_token)
        throw new GcpAuthError("Malformed token response", "bad_response");
      return { value: body.id_token, expiresAt: jwtExpiry(body.id_token) };
    });
  }
}
