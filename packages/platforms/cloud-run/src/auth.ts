import {
  CLOUD_PLATFORM_SCOPE,
  type Fetch,
  GcpTokenVerificationError,
  MetadataTokenSource,
  type TokenSource,
  verifyGoogleIdToken,
} from "@moriyoshi/errtraq-gcp-auth";

/**
 * OAuth scope of a Cloud SQL IAM login token. TO VERIFY (G8): that the metadata server issues it
 * for the function's service account on Cloud Run, and whether `cloud-platform` would also do.
 */
export const SQL_LOGIN_SCOPE =
  "https://www.googleapis.com/auth/sqlservice.login";

type Headers =
  | globalThis.Headers
  | Readonly<Record<string, string | undefined>>;
export function bearerToken(headers: Headers): string | undefined {
  const value =
    headers instanceof globalThis.Headers
      ? headers.get("authorization")
      : (headers.authorization ??
        Object.entries(headers).find(
          ([name]) => name.toLowerCase() === "authorization",
        )?.[1]);
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(value ?? "");
  return match?.[1];
}

export interface OidcVerifierOptions {
  /** The audience the platform module put on the push subscription or Scheduler job. */
  audience: string | undefined;
  /** The invoker identity; omitted only for the operator route, where Cloud Run IAM decides. */
  email?: string | undefined;
  /** Require `email` to be set, so a missing binding fails closed. */
  requireEmail?: boolean;
  verify?: typeof verifyGoogleIdToken;
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}
/**
 * Verify a Google-signed ID token from the `Authorization` header (signature, issuer, audience,
 * expiry and, when configured, the invoker service account). Fails closed: a missing audience or
 * email binding rejects every request. The reason is logged without the token.
 */
export function createOidcVerifier(
  options: OidcVerifierOptions,
): (headers: Headers) => Promise<boolean> {
  const verify = options.verify ?? verifyGoogleIdToken;
  return async (headers) => {
    const token = bearerToken(headers);
    if (
      !token ||
      !options.audience ||
      (options.requireEmail && !options.email)
    ) {
      options.logger?.warn("OIDC verification rejected a request", {
        reason: !token ? "missing token" : "missing binding",
      });
      return false;
    }
    try {
      await verify(token, {
        audience: options.audience,
        ...(options.email ? { email: options.email } : {}),
      });
      return true;
    } catch (error) {
      if (!(error instanceof GcpTokenVerificationError)) throw error;
      options.logger?.warn("OIDC verification rejected a request", {
        reason: error.message,
      });
      return false;
    }
  };
}

export interface GcpRuntimeAuth {
  tokens: TokenSource;
  accessToken(): Promise<string>;
  /** Cloud SQL IAM login token (scope `sqlservice.login`). */
  sqlAccessToken(): Promise<string>;
  serviceAccountEmail(): Promise<string>;
}
/**
 * Credentials of a Cloud Run instance: the metadata server only. `GOOGLE_APPLICATION_CREDENTIALS`
 * is never read here (a key file does not belong on Cloud Run); `GCE_METADATA_HOST` is honoured
 * for emulators.
 */
export function createGcpRuntimeAuth(
  environment: Readonly<Record<string, string | undefined>>,
  fetcher?: Fetch,
): GcpRuntimeAuth {
  const tokens = new MetadataTokenSource({
    host: environment.GCE_METADATA_HOST,
    fetch: fetcher,
  });
  return {
    tokens,
    accessToken: () => tokens.getAccessToken([CLOUD_PLATFORM_SCOPE]),
    sqlAccessToken: () => tokens.getAccessToken([SQL_LOGIN_SCOPE]),
    serviceAccountEmail: () => tokens.serviceAccountEmail(),
  };
}

/**
 * Auth over a token source that is not the metadata server (the operator CLI): Cloud SQL logins
 * and database users need the service account email, which only a service account has.
 */
export function gcpAuthFromTokens(
  tokens: TokenSource,
  email?: string,
): GcpRuntimeAuth {
  return {
    tokens,
    accessToken: () => tokens.getAccessToken([CLOUD_PLATFORM_SCOPE]),
    sqlAccessToken: () => tokens.getAccessToken([SQL_LOGIN_SCOPE]),
    serviceAccountEmail: async () => {
      if (!email) throw new Error("No service account email");
      return email;
    },
  };
}
/**
 * Host bindings (never configuration) for the GCP adapters: the token sources they declare as
 * TODO(G5) inputs. `blob-gcs` resolves the metadata server itself, so it needs none.
 */
export function gcpHostBindings(
  auth: GcpRuntimeAuth,
  verifyPush: (request: { headers: Headers }) => Promise<boolean>,
): (selection: {
  path: string;
  id: string;
  kind: string;
}) => Record<string, unknown> {
  return (selection) => {
    switch (selection.id) {
      case "store-firestore":
      case "kv-firestore":
        return { accessToken: auth.accessToken };
      case "queue-pubsub":
        return { accessToken: auth.accessToken, verifyPush };
      case "postgres":
        // RDS mode ignores both; Cloud SQL IAM mode reads them.
        return {
          accessToken: auth.sqlAccessToken,
          serviceAccountEmail: auth.serviceAccountEmail,
        };
      default:
        return {};
    }
  };
}
