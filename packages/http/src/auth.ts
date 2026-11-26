import {
  type ActiveStore,
  type ApiTokenId,
  type AuthSettings,
  type GrantSetting,
  hashApiToken,
  type Logger,
  type OidcSettings,
  type OrgId,
  type SignedProxySettings,
  type UnsignedProxySettings,
} from "@moriyoshi/errtraq-core/runtime";
import {
  resolveSignedProxy,
  timingSafeEqual,
  unsignedClaims,
  unsignedIdentityHeaders,
} from "./identity-proxy.js";
import {
  AuthError,
  type Claims,
  type FetchLike,
  JwksKeySource,
  type KeySource,
  looksLikeJwt,
  PemKidKeySource,
  verifyJwt,
} from "./jwt.js";

/** Who a request acts as: the one shape every route reads. */
export interface Principal {
  kind: "token" | "oidc" | "proxy";
  orgId: OrgId;
  scopes: string[];
  /** `sub` (or the forwarded user) for an OIDC or proxy principal. */
  subject?: string;
  email?: string;
  tokenId?: ApiTokenId;
}
export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; detail: string };

const DENIED = { ok: false, status: 401, detail: "Invalid token" } as const;
const REQUIRED = {
  ok: false,
  status: 401,
  detail: "Authentication required",
} as const;
const NO_GRANT = {
  ok: false,
  status: 403,
  detail: "No access is granted to this identity",
} as const;

export interface AuthenticatorOptions {
  store: ActiveStore;
  /** Seconds since the epoch. */
  now: () => number;
  settings?: AuthSettings;
  fetch?: FetchLike;
  logger?: Pick<Logger, "error">;
}

/** Match grants against verified claims; one organization per principal. */
async function resolveGrants(
  store: ActiveStore,
  grants: readonly GrantSetting[],
  claims: Claims,
  emailTrusted: boolean,
): Promise<{ orgId: OrgId; scopes: string[] } | typeof NO_GRANT> {
  const matched = grants.filter((grant) => {
    const value = claims[grant.claim];
    if (grant.claim === "email") {
      if (claims.email_verified !== true && !emailTrusted) return false;
      const want = grant.value.toLowerCase();
      return Array.isArray(value)
        ? false
        : typeof value === "string" && value.toLowerCase() === want;
    }
    return Array.isArray(value)
      ? value.includes(grant.value)
      : value === grant.value;
  });
  if (matched.length === 0) return NO_GRANT;
  const slugs = new Set(matched.map((grant) => grant.org));
  // The API is single organization per principal: two organizations at once is refused.
  if (slugs.size !== 1) return NO_GRANT;
  const org = await store.projects.getOrgBySlug([...slugs][0] as string);
  if (!org) return NO_GRANT;
  return {
    orgId: org.id,
    scopes: [...new Set(matched.flatMap((grant) => grant.scopes))],
  };
}

function principalFrom(
  kind: "oidc" | "proxy",
  claims: Claims,
  granted: { orgId: OrgId; scopes: string[] },
): Principal {
  const subject =
    typeof claims.sub === "string"
      ? claims.sub
      : typeof claims.email === "string"
        ? claims.email
        : undefined;
  return {
    kind,
    orgId: granted.orgId,
    scopes: granted.scopes,
    ...(subject ? { subject } : {}),
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
  };
}

/** Builds the per-request authenticator: API token, then configured proxy, then Bearer JWT. */
export function createAuthenticator(options: AuthenticatorOptions) {
  const { store, now, settings } = options;
  const fetchFn = options.fetch;
  const onFetchFailure = (cls: string) =>
    options.logger?.error("Identity key fetch failed", { class: cls });
  const common = {
    ...(fetchFn ? { fetch: fetchFn } : {}),
    now,
    onFetchFailure,
  };

  const oidc: OidcSettings | undefined = settings?.oidc;
  const oidcKeys: KeySource | undefined = oidc
    ? new JwksKeySource({
        ...common,
        issuer: oidc.issuer,
        ...(oidc.jwks ? { jwks: oidc.jwks } : {}),
        ...(oidc.jwksUri ? { jwksUri: oidc.jwksUri } : {}),
      })
    : undefined;

  const signed: SignedProxySettings | undefined =
    settings?.proxy?.kind === "signed" ? settings.proxy : undefined;
  const unsigned: UnsignedProxySettings | undefined =
    settings?.proxy?.kind === "unsigned" ? settings.proxy : undefined;
  const signedResolved = signed ? resolveSignedProxy(signed) : undefined;
  const signedKeys: KeySource | undefined = signedResolved
    ? signedResolved.keys.type === "pem"
      ? new PemKidKeySource({
          ...common,
          urlTemplate: signedResolved.keys.urlTemplate,
        })
      : new JwksKeySource({
          ...common,
          ...(signedResolved.keys.issuer
            ? { issuer: signedResolved.keys.issuer }
            : {}),
          ...(signedResolved.keys.jwks
            ? { jwks: signedResolved.keys.jwks }
            : {}),
          ...(signedResolved.keys.jwksUri
            ? { jwksUri: signedResolved.keys.jwksUri }
            : {}),
        })
    : undefined;
  const unsignedHeaders = unsigned ? unsignedIdentityHeaders(unsigned) : [];

  async function apiToken(bearer: string): Promise<AuthResult> {
    const token = await store.projects.getTokenByHash(
      await hashApiToken(bearer),
    );
    if (!token || token.revokedAt) return DENIED;
    return {
      ok: true,
      principal: {
        kind: "token",
        orgId: token.orgId,
        scopes: token.scopes,
        tokenId: token.id,
      },
    };
  }

  async function guarded(
    verify: () => Promise<{
      kind: "oidc" | "proxy";
      claims: Claims;
      trusted: boolean;
      grants: readonly GrantSetting[];
    }>,
  ): Promise<AuthResult> {
    let verified: Awaited<ReturnType<typeof verify>>;
    try {
      verified = await verify();
    } catch (error) {
      // Class only; never the token, the claims or the reason text a client could probe.
      if (error instanceof AuthError && error.kind === "unavailable")
        onFetchFailure("unavailable");
      return DENIED;
    }
    const granted = await resolveGrants(
      store,
      verified.grants,
      verified.claims,
      verified.trusted,
    );
    if ("ok" in granted) return granted;
    return {
      ok: true,
      principal: principalFrom(verified.kind, verified.claims, granted),
    };
  }

  /** `undefined` means no proxy assertion is present, so the next source may run. */
  async function proxy(request: Request): Promise<AuthResult | undefined> {
    if (signed && signedResolved && signedKeys) {
      const assertion = request.headers.get(signedResolved.header);
      if (assertion === null) return undefined;
      return guarded(async () => {
        const verified = await verifyJwt(assertion, signedKeys, {
          ...signedResolved.rules,
          now,
        });
        return {
          kind: "proxy",
          claims: verified.claims,
          trusted: signedResolved.assumeEmailVerified,
          grants: signed.grants,
        };
      });
    }
    if (unsigned) {
      if (!unsignedHeaders.some((name) => request.headers.has(name)))
        return undefined;
      return guarded(async () => {
        const secret = request.headers.get(unsigned.secretHeader);
        if (
          secret === null ||
          !(await timingSafeEqual(secret, unsigned.secret))
        )
          throw new AuthError("shared secret mismatch");
        const claims = unsignedClaims(unsigned, request.headers);
        if (typeof claims.sub !== "string" && typeof claims.email !== "string")
          throw new AuthError("no identity");
        return {
          kind: "proxy",
          claims,
          trusted: unsigned.emailVerified === true,
          grants: unsigned.grants,
        };
      });
    }
    return undefined;
  }

  return async function authenticate(request: Request): Promise<AuthResult> {
    const bearer = request.headers
      .get("authorization")
      ?.match(/^Bearer\s+(\S+)$/i)?.[1];
    // 1. API tokens: never a JWT lookup, never the JWT verifier.
    if (bearer?.startsWith("errtraq_")) return apiToken(bearer);
    // 2. The configured proxy; a failed assertion is final.
    const viaProxy = await proxy(request);
    if (viaProxy) return viaProxy;
    // 3. A Bearer JWT.
    if (!bearer) return REQUIRED;
    if (!oidc || !oidcKeys || !looksLikeJwt(bearer)) return DENIED;
    return guarded(async () => {
      const verified = await verifyJwt(bearer, oidcKeys, {
        algorithms: oidc.algorithms ?? ["RS256", "ES256"],
        issuer: oidc.issuer,
        audience: oidc.audience,
        ...(oidc.audienceClaim ? { audienceClaim: oidc.audienceClaim } : {}),
        ...(oidc.tokenUse ? { tokenUse: oidc.tokenUse } : {}),
        ...(oidc.typ ? { typ: oidc.typ } : {}),
        ...(oidc.maxLifetimeSec ? { maxLifetimeSec: oidc.maxLifetimeSec } : {}),
        now,
      });
      return {
        kind: "oidc",
        claims: verified.claims,
        trusted: false,
        grants: oidc.grants,
      };
    });
  };
}

/** The header proxy-authenticated writes must carry; a cross-site form cannot set it. */
export const CSRF_HEADER = "x-errtraq-csrf";
const WRITE_METHODS = ["PUT", "POST", "PATCH", "DELETE"];
/** Writes by a cookie-authenticated (proxy) principal need the CSRF header and a JSON body type. */
export function csrfAllowed(request: Request): boolean {
  if (!WRITE_METHODS.includes(request.method)) return true;
  if (request.headers.get(CSRF_HEADER) !== "1") return false;
  const hasBody =
    request.body !== null ||
    request.headers.has("transfer-encoding") ||
    (request.headers.get("content-length") ?? "0") !== "0";
  if (!hasBody) return true;
  return /^application\/(?:[a-z0-9.+-]+\+)?json\s*(?:;|$)/i.test(
    request.headers.get("content-type") ?? "",
  );
}
