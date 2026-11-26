import { createSignal } from "solid-js";

/**
 * The API token lives in `sessionStorage` only: it dies with the tab and is never written to a
 * cookie or `localStorage`. Storage can throw (private windows, blocked site data), so every
 * access is guarded and the token then lives in memory for the page's lifetime.
 */
const KEY = "errtraq.token";

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let current = read();
const [token, setToken] = createSignal<string | null>(current);

export { token };

/**
 * The token without subscribing to it. Route guards (`beforeLoad`) must use this: reading the
 * signal inside the router's tracked scope re-runs the guard on every login and logout.
 */
export function peekToken(): string | null {
  return current;
}

export function saveToken(value: string): void {
  current = value;
  setToken(value);
  try {
    sessionStorage.setItem(KEY, value);
  } catch {
    // in-memory only
  }
}

export function clearToken(): void {
  current = null;
  setToken(null);
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
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
