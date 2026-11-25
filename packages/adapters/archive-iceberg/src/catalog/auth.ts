import { signAwsRequest } from "@moriyoshi/errtraq-aws-signing";
import { CatalogAuthError } from "./errors.js";

type MaybePromise<T> = T | Promise<T>;
/** A secret that may be resolved lazily (secret store, refreshed credentials). */
export type SecretValue = string | (() => MaybePromise<string>);
export interface AwsCredentialsValue {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type CatalogAuth =
  | { type: "none" }
  | { type: "bearer"; token: SecretValue }
  | {
      type: "oauth2";
      clientId: string;
      clientSecret: SecretValue;
      /** Defaults to `oauth2-server-uri` from the catalog config, then `<uri>/v1/oauth/tokens`. */
      tokenEndpoint?: string;
      /** Defaults to `catalog`, the scope the REST spec names. */
      scope?: string;
    }
  | {
      type: "sigv4";
      region: string;
      credentials: () => MaybePromise<AwsCredentialsValue>;
      /** `s3tables` for S3 Tables (the default), `glue` for the Glue REST endpoint. */
      signingName?: string;
    };

export interface AuthContext {
  fetch: typeof fetch;
  now: () => number;
  /** The catalog base URI; the default token endpoint hangs off it. */
  baseUri: string;
  timeoutMs: number;
}

/** Seconds before expiry at which a cached OAuth2 token is considered stale. */
const TOKEN_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_MS = 3_600_000;

async function resolveSecret(value: SecretValue): Promise<string> {
  return typeof value === "function" ? value() : value;
}

/** Signs or decorates catalog requests according to the configured mode. */
export class RequestAuthenticator {
  private token: { value: string; expiresAt: number } | undefined;
  private refreshing: Promise<string> | undefined;
  private discoveredTokenEndpoint: string | undefined;
  constructor(
    private readonly auth: CatalogAuth,
    private readonly context: AuthContext,
  ) {}

  /** Record `oauth2-server-uri` from the catalog config. */
  setDiscoveredTokenEndpoint(uri: string | undefined): void {
    this.discoveredTokenEndpoint = uri;
  }

  /** Invalidate the cached token (after a 401) so the next call fetches a new one. */
  invalidate(): void {
    this.token = undefined;
  }

  /** True when a 401 may be cured by a fresh token. */
  get refreshable(): boolean {
    return this.auth.type === "oauth2";
  }

  async authenticate(request: {
    method: string;
    url: string;
    headers: Headers;
    body: string | undefined;
  }): Promise<{ url: string; headers: Headers }> {
    const auth = this.auth;
    switch (auth.type) {
      case "none":
        return { url: request.url, headers: request.headers };
      case "bearer": {
        request.headers.set(
          "authorization",
          `Bearer ${await resolveSecret(auth.token)}`,
        );
        return { url: request.url, headers: request.headers };
      }
      case "oauth2": {
        request.headers.set(
          "authorization",
          `Bearer ${await this.accessToken(auth)}`,
        );
        return { url: request.url, headers: request.headers };
      }
      case "sigv4": {
        const credentials = await auth.credentials();
        const signed = await signAwsRequest({
          ...credentials,
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body ?? null,
          service: auth.signingName ?? "s3tables",
          region: auth.region,
        });
        return { url: signed.url.toString(), headers: signed.headers };
      }
    }
  }

  private accessToken(
    auth: Extract<CatalogAuth, { type: "oauth2" }>,
  ): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_SKEW_MS > this.context.now())
      return Promise.resolve(this.token.value);
    // One in-flight refresh serves every concurrent caller.
    this.refreshing ??= this.fetchToken(auth).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async fetchToken(
    auth: Extract<CatalogAuth, { type: "oauth2" }>,
  ): Promise<string> {
    const endpoint =
      auth.tokenEndpoint ??
      this.discoveredTokenEndpoint ??
      `${this.context.baseUri}/v1/oauth/tokens`;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: auth.clientId,
      client_secret: await resolveSecret(auth.clientSecret),
      scope: auth.scope ?? "catalog",
    });
    const response = await this.context.fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(this.context.timeoutMs),
    });
    const text = await response.text();
    let parsed: { access_token?: unknown; expires_in?: unknown } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // handled below
    }
    if (
      !response.ok ||
      typeof parsed.access_token !== "string" ||
      !parsed.access_token
    )
      throw new CatalogAuthError({
        operation: "oauth2 token",
        status: response.status,
        // Never echo the response when it is not the OAuth error envelope: it may hold secrets.
        rawBody: undefined,
      });
    const ttl =
      typeof parsed.expires_in === "number" && parsed.expires_in > 0
        ? parsed.expires_in * 1000
        : DEFAULT_TOKEN_TTL_MS;
    this.token = {
      value: parsed.access_token,
      expiresAt: this.context.now() + ttl,
    };
    return parsed.access_token;
  }
}
