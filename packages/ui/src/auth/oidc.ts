import type { OidcClientConfig } from "./config";
import { challengeOf, createVerifier, randomString } from "./pkce";

/**
 * Authorization Code + PKCE (S256) against any OIDC provider. Only the Bearer token and its
 * expiry are stored afterwards. The ID token is checked for `nonce` here; its signature is not,
 * because the API verifies the Bearer token it is given.
 */

const PENDING_KEY = "errtraq.oidc.pending";
export const CALLBACK_PATH = "/auth/callback";

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface OidcDeps {
  fetch: typeof fetch;
  storage: Store;
  /** Page origin, for the redirect URI. */
  origin: string;
  now: () => number;
}

export class OidcError extends Error {
  override readonly name = "OidcError";
}

export interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

const isSecureUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
};

export async function discover(
  config: OidcClientConfig,
  fetchFn: typeof fetch,
): Promise<Discovery> {
  const url = `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  let doc: Record<string, unknown>;
  try {
    const response = await fetchFn(url, { credentials: "omit" });
    if (!response.ok) throw new Error(String(response.status));
    doc = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OidcError("Could not reach the identity provider.");
  }
  // The issuer in the document must be the configured one (OIDC Discovery section 4.3).
  if (doc.issuer !== config.issuer)
    throw new OidcError("The identity provider reported a different issuer.");
  const { authorization_endpoint: auth, token_endpoint: token } = doc;
  if (
    typeof auth !== "string" ||
    typeof token !== "string" ||
    !isSecureUrl(auth) ||
    !isSecureUrl(token)
  )
    throw new OidcError("The identity provider's endpoints are not usable.");
  const end = doc.end_session_endpoint;
  return {
    authorization_endpoint: auth,
    token_endpoint: token,
    ...(typeof end === "string" && isSecureUrl(end)
      ? { end_session_endpoint: end }
      : {}),
  };
}

export function redirectUri(origin: string): string {
  return `${origin}${CALLBACK_PATH}`;
}

/** Build the authorization request and remember `state`, `nonce` and the verifier for the round trip. */
export async function beginSignIn(
  config: OidcClientConfig,
  deps: OidcDeps,
): Promise<string> {
  const discovery = await discover(config, deps.fetch);
  const verifier = createVerifier();
  const state = randomString(32);
  const nonce = randomString(32);
  deps.storage.setItem(
    PENDING_KEY,
    JSON.stringify({ state, nonce, verifier, at: deps.now() }),
  );
  const url = new URL(discovery.authorization_endpoint);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", config.clientId);
  params.set("redirect_uri", redirectUri(deps.origin));
  params.set("scope", config.scopes);
  params.set("state", state);
  params.set("nonce", nonce);
  params.set("code_challenge", await challengeOf(verifier));
  params.set("code_challenge_method", "S256");
  return url.toString();
}

/** The callback URL without the authorization response parameters. */
export function cleanCallbackUrl(href: string): string {
  const url = new URL(href);
  for (const name of [
    "code",
    "state",
    "session_state",
    "iss",
    "error",
    "error_description",
  ])
    url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  at: number;
}
/** A sign-in that is not finished within this time is abandoned. */
const PENDING_MAX_AGE_MS = 10 * 60_000;
function takePending(storage: Store, now: number): Pending | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PENDING_KEY);
    storage.removeItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Pending>;
    if (
      typeof value.state === "string" &&
      typeof value.nonce === "string" &&
      typeof value.verifier === "string" &&
      typeof value.at === "number" &&
      now - value.at <= PENDING_MAX_AGE_MS
    )
      return value as Pending;
  } catch {
    // fall through
  }
  return null;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const binary = atob(part.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface SignedIn {
  token: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

/** Finish the round trip: check `state`, exchange the code, check the ID token's `nonce`. */
export async function completeSignIn(
  config: OidcClientConfig,
  search: string,
  deps: OidcDeps,
): Promise<SignedIn> {
  const params = new URLSearchParams(search);
  // The pending record is single use, whatever happens next.
  const pending = takePending(deps.storage, deps.now());
  const error = params.get("error");
  if (error)
    throw new OidcError(
      `The identity provider refused the sign-in (${error.slice(0, 80)}).`,
    );
  const code = params.get("code");
  const state = params.get("state");
  if (!pending || !code || !state || state !== pending.state)
    throw new OidcError(
      "The sign-in response did not match a sign-in started here.",
    );
  const discovery = await discover(config, deps.fetch);
  let body: Record<string, unknown>;
  try {
    const response = await deps.fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      credentials: "omit",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(deps.origin),
        client_id: config.clientId,
        code_verifier: pending.verifier,
      }),
    });
    if (!response.ok) throw new Error(String(response.status));
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OidcError(
      "The identity provider rejected the authorization code.",
    );
  }
  const idToken = body.id_token;
  const idClaims = typeof idToken === "string" ? jwtPayload(idToken) : null;
  if (!idClaims || idClaims.nonce !== pending.nonce)
    throw new OidcError("The ID token did not carry the expected nonce.");
  const token = config.tokenKind === "id" ? idToken : body.access_token;
  if (typeof token !== "string" || !token)
    throw new OidcError(
      `The identity provider returned no ${config.tokenKind} token.`,
    );
  const claims = jwtPayload(token);
  const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : undefined;
  const lifetime =
    typeof body.expires_in === "number" ? body.expires_in * 1000 : 3_600_000;
  return { token, expiresAt: exp ?? deps.now() + lifetime };
}

/** The end-session URL when the provider has one; the caller falls back to the login page. */
export async function logoutUrl(
  config: OidcClientConfig,
  deps: Pick<OidcDeps, "fetch" | "origin">,
): Promise<string | null> {
  try {
    const { end_session_endpoint } = await discover(config, deps.fetch);
    if (!end_session_endpoint) return null;
    const url = new URL(end_session_endpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("post_logout_redirect_uri", `${deps.origin}/login`);
    return url.toString();
  } catch {
    return null;
  }
}
