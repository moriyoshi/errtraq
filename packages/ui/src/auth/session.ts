import { createSignal } from "solid-js";
import { authMode } from "./config";

/**
 * The Bearer token (an API token or the token an OIDC sign-in produced) lives in `sessionStorage`
 * only: it dies with the tab and is never written to a cookie or `localStorage`. Storage can
 * throw (private windows, blocked site data), so every access is guarded and the token then lives
 * in memory for the page's lifetime. A token with an expiry is dropped once it has passed.
 * In proxy mode there is no token at all: the proxy's session cookie is the credential.
 */
const KEY = "errtraq.token";
const EXPIRY_KEY = "errtraq.token.expires";

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function forget(): void {
  for (const key of [KEY, EXPIRY_KEY])
    try {
      sessionStorage.removeItem(key);
    } catch {
      // nothing to clear
    }
}

let current = read(KEY);
let expiresAt: number | null = Number(read(EXPIRY_KEY)) || null;
if (current && expiresAt && Date.now() >= expiresAt) {
  current = null;
  expiresAt = null;
  forget();
}
const [token, setToken] = createSignal<string | null>(current);
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

export { token };

/**
 * The token without subscribing to it. Route guards (`beforeLoad`) must use this: reading the
 * signal inside the router's tracked scope re-runs the guard on every login and logout.
 */
export function peekToken(): string | null {
  if (current && expiresAt && Date.now() >= expiresAt) handleUnauthorized();
  return current;
}

/** Whether the app can call the API: it has a token, or the proxy's session is the credential. */
export function isSignedIn(): boolean {
  return authMode === "proxy" || peekToken() !== null;
}

function arm(): void {
  clearTimeout(expiryTimer);
  if (!expiresAt) return;
  // setTimeout caps at about 24.8 days; peekToken re-checks the expiry anyway.
  const wait = Math.min(Math.max(expiresAt - Date.now(), 0), 2 ** 31 - 1);
  expiryTimer = setTimeout(() => {
    if (expiresAt && Date.now() >= expiresAt) handleUnauthorized();
  }, wait);
}

export function saveToken(value: string, expiry?: number): void {
  current = value;
  expiresAt = expiry ?? null;
  setToken(value);
  try {
    sessionStorage.setItem(KEY, value);
    if (expiry) sessionStorage.setItem(EXPIRY_KEY, String(expiry));
    else sessionStorage.removeItem(EXPIRY_KEY);
  } catch {
    // in-memory only
  }
  arm();
}

export function clearToken(): void {
  current = null;
  expiresAt = null;
  clearTimeout(expiryTimer);
  setToken(null);
  forget();
}

let unauthorizedHandler: () => void = clearToken;

/** The app registers what happens after a 401 (clear caches, go to the login page). */
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

export function handleUnauthorized(): void {
  clearToken();
  unauthorizedHandler();
}
