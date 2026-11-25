import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Fetch,
  GcpAuthError,
  MetadataTokenSource,
  ServiceAccountTokenSource,
  scopeKey,
  TokenCache,
  type TokenSource,
} from "@moriyoshi/errtraq-gcp-auth";

type Environment = Readonly<Record<string, string | undefined>>;
export interface OperatorGcpCredentials {
  tokens: TokenSource;
  /** The service account's email when the credentials are one (needed for the Cloud SQL IAM user). */
  email?: string;
}
export interface OperatorGcpOptions {
  fetch?: Fetch;
  readFile?: (path: string) => Promise<string>;
  homeDirectory?: string;
  /** Throw when nothing resolves (default true; there is no useful fallback for a signed call). */
  required?: boolean;
}
/**
 * An authorized-user ADC (`gcloud auth application-default login`): a refresh token for the
 * gcloud OAuth client. It mints access tokens, but not ID tokens for an arbitrary audience.
 */
class RefreshTokenSource implements TokenSource {
  private readonly cache = new TokenCache(Date.now);
  constructor(
    private readonly credentials: {
      client_id: string;
      client_secret: string;
      refresh_token: string;
    },
    private readonly fetcher: Fetch,
  ) {}
  getAccessToken(scopes?: readonly string[]): Promise<string> {
    return this.cache.get(`access:${scopeKey(scopes)}`, async () => {
      let response: Response;
      try {
        response = await this.fetcher("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: this.credentials.client_id,
            client_secret: this.credentials.client_secret,
            refresh_token: this.credentials.refresh_token,
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new GcpAuthError("Token endpoint is unreachable", "unavailable");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new GcpAuthError(
          `Token endpoint rejected the refresh token (${response.status})`,
          "denied",
          response.status,
        );
      }
      const body = (await response.json().catch(() => null)) as {
        access_token?: unknown;
        expires_in?: unknown;
      } | null;
      if (
        typeof body?.access_token !== "string" ||
        typeof body.expires_in !== "number"
      )
        throw new GcpAuthError("Malformed token response", "bad_response");
      return {
        value: body.access_token,
        expiresAt: Date.now() + body.expires_in * 1000,
      };
    });
  }
  async getIdToken(): Promise<never> {
    throw new GcpAuthError(
      "Application default user credentials cannot mint ID tokens for a service; use a service account key (GOOGLE_APPLICATION_CREDENTIALS) or set ERRTRAQ_GCP_ID_TOKEN (gcloud auth print-identity-token --audiences=<audience>)",
      "unsupported",
    );
  }
}
/** A pre-minted ID token (the only way an authorized user can call an authenticated service). */
function withIdToken(tokens: TokenSource, idToken: string): TokenSource {
  return {
    getAccessToken: (scopes) => tokens.getAccessToken(scopes),
    getIdToken: async () => idToken,
  };
}
/**
 * Operator-machine (CLI only) Google credentials, resolved like Application Default Credentials:
 * `GOOGLE_APPLICATION_CREDENTIALS` (service account key or authorized user file), then the gcloud
 * ADC file, then the metadata server when `GCE_METADATA_HOST` is set. `ERRTRAQ_GCP_ID_TOKEN`
 * supplies the ID token for `bootstrap --remote` when the credentials cannot mint one. Deployed
 * code never calls this: Cloud Run uses the metadata server and never a key file.
 */
export async function resolveOperatorGcpCredentials(
  environment: Environment,
  options: OperatorGcpOptions = {},
): Promise<OperatorGcpCredentials> {
  const fetcher = options.fetch ?? fetch;
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const configured = environment.GOOGLE_APPLICATION_CREDENTIALS;
  const wellKnown = join(
    environment.CLOUDSDK_CONFIG ??
      join(options.homeDirectory ?? homedir(), ".config", "gcloud"),
    "application_default_credentials.json",
  );
  const idToken = environment.ERRTRAQ_GCP_ID_TOKEN;
  const finish = (credentials: OperatorGcpCredentials) =>
    idToken
      ? { ...credentials, tokens: withIdToken(credentials.tokens, idToken) }
      : credentials;
  for (const path of [configured, wellKnown]) {
    if (!path) continue;
    let text: string;
    try {
      text = await read(path);
    } catch {
      // A named file must exist; the well-known one is optional.
      if (path === configured)
        throw new Error("Cannot read GOOGLE_APPLICATION_CREDENTIALS");
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("Google credentials file is not valid JSON");
    }
    if (parsed.type === "service_account") {
      const source = new ServiceAccountTokenSource({
        key: text,
        fetch: fetcher,
      });
      return finish({ tokens: source, email: source.email });
    }
    if (
      parsed.type === "authorized_user" &&
      typeof parsed.client_id === "string" &&
      typeof parsed.client_secret === "string" &&
      typeof parsed.refresh_token === "string"
    )
      return finish({
        tokens: new RefreshTokenSource(
          {
            client_id: parsed.client_id,
            client_secret: parsed.client_secret,
            refresh_token: parsed.refresh_token,
          },
          fetcher,
        ),
      });
    throw new Error("Unsupported Google credentials file type");
  }
  if (environment.GCE_METADATA_HOST)
    return finish({
      tokens: new MetadataTokenSource({
        host: environment.GCE_METADATA_HOST,
        fetch: fetcher,
      }),
    });
  if (options.required === false) return { tokens: unavailable() };
  throw new Error(
    "No Google credentials found: run `gcloud auth application-default login` or set GOOGLE_APPLICATION_CREDENTIALS",
  );
}
function unavailable(): TokenSource {
  const fail = async (): Promise<never> => {
    throw new GcpAuthError("No Google credentials", "unavailable");
  };
  return { getAccessToken: fail, getIdToken: fail };
}
