/** Build-time sign-in configuration, read once from `VITE_ERRTRAQ_*`. */

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  scopes: string;
  /** Which token to send as the Bearer token. */
  tokenKind: "access" | "id";
}
export type AuthMode = "token" | "proxy";

type Env = Record<string, string | undefined>;

/** `null` when no issuer is set: token login only, exactly as before. */
export function readOidcConfig(env: Env): OidcClientConfig | null {
  const issuer = env.VITE_ERRTRAQ_OIDC_ISSUER?.trim();
  if (!issuer) return null;
  const clientId = env.VITE_ERRTRAQ_OIDC_CLIENT_ID?.trim();
  if (!clientId)
    throw new Error("VITE_ERRTRAQ_OIDC_CLIENT_ID is required with an issuer");
  const kind = env.VITE_ERRTRAQ_OIDC_TOKEN?.trim() || "access";
  if (kind !== "access" && kind !== "id")
    throw new Error("VITE_ERRTRAQ_OIDC_TOKEN must be access or id");
  return {
    issuer,
    clientId,
    scopes: env.VITE_ERRTRAQ_OIDC_SCOPES?.trim() || "openid email profile",
    tokenKind: kind,
  };
}

export function readAuthMode(env: Env): AuthMode {
  const mode = env.VITE_ERRTRAQ_AUTH?.trim();
  if (!mode || mode === "token") return "token";
  if (mode === "proxy") return "proxy";
  throw new Error("VITE_ERRTRAQ_AUTH must be token or proxy");
}

export const authMode: AuthMode = readAuthMode(import.meta.env);
export const oidcConfig: OidcClientConfig | null =
  authMode === "token" ? readOidcConfig(import.meta.env) : null;
/** Where "Log out" goes in proxy mode (the proxy's own sign-out URL); optional. */
export const proxyLogoutUrl: string | undefined =
  import.meta.env.VITE_ERRTRAQ_PROXY_LOGOUT_URL || undefined;
