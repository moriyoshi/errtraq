import { GcpAuthError } from "./errors.js";
import { jwtExpiry } from "./jwt.js";
import {
  type Clock,
  type Fetch,
  scopeKey,
  TokenCache,
  type TokenSource,
} from "./token-source.js";

export interface MetadataOptions {
  /** Host of the metadata server (the `GCE_METADATA_HOST` override); default `metadata.google.internal`. */
  host?: string;
  /** Service account alias or email; default `default`. */
  serviceAccount?: string;
  fetch?: Fetch;
  clock?: Clock;
  /** Refresh this long before expiry. Default 60 seconds. */
  skewMs?: number;
  requestTimeoutMs?: number;
}
const FLAVOR = { "metadata-flavor": "Google" };

/** Client for the GCE/Cloud Run metadata server with cached tokens and single-flight refresh. */
export class MetadataTokenSource implements TokenSource {
  private readonly base: string;
  private readonly fetcher: Fetch;
  private readonly clock: Clock;
  private readonly cache: TokenCache;
  private readonly timeoutMs: number;
  private email?: Promise<string>;
  constructor(options: MetadataOptions = {}) {
    const host = options.host ?? "metadata.google.internal";
    if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(host))
      throw new TypeError("Invalid metadata host");
    this.base = `http://${host}/computeMetadata/v1/instance/service-accounts/${encodeURIComponent(options.serviceAccount ?? "default")}`;
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.cache = new TokenCache(this.clock, options.skewMs);
    this.timeoutMs = options.requestTimeoutMs ?? 5000;
  }
  private async call(path: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}/${path}`, {
        headers: FLAVOR,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GcpAuthError("Metadata server is unreachable", "unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GcpAuthError(
        `Metadata server request failed (${response.status})`,
        response.status >= 500 || response.status === 429
          ? "unavailable"
          : "denied",
        response.status,
      );
    }
    return response;
  }
  getAccessToken(scopes?: readonly string[]): Promise<string> {
    const key = `access:${scopeKey(scopes)}`;
    return this.cache.get(key, async () => {
      const query = scopes?.length
        ? `?scopes=${encodeURIComponent([...new Set(scopes)].sort().join(","))}`
        : "";
      const response = await this.call(`token${query}`);
      const body = (await response.json().catch(() => null)) as {
        access_token?: unknown;
        expires_in?: unknown;
      } | null;
      if (
        !body ||
        typeof body.access_token !== "string" ||
        !body.access_token ||
        typeof body.expires_in !== "number" ||
        !(body.expires_in > 0)
      )
        throw new GcpAuthError(
          "Malformed metadata token response",
          "bad_response",
        );
      return {
        value: body.access_token,
        expiresAt: this.clock() + body.expires_in * 1000,
      };
    });
  }
  getIdToken(audience: string): Promise<string> {
    if (!audience) throw new TypeError("ID token audience is required");
    return this.cache.get(`id:${audience}`, async () => {
      const response = await this.call(
        `identity?audience=${encodeURIComponent(audience)}&format=full`,
      );
      const token = (await response.text()).trim();
      return { value: token, expiresAt: jwtExpiry(token) };
    });
  }
  /** The service account's email address (cached after the first success). */
  serviceAccountEmail(): Promise<string> {
    this.email ??= this.call("email")
      .then(async (response) => (await response.text()).trim())
      .then((email) => {
        if (!email) throw new GcpAuthError("Empty email", "bad_response");
        return email;
      })
      .catch((error) => {
        this.email = undefined;
        throw error;
      });
    return this.email;
  }
}
