/** Proxy mode: the identity-aware proxy owns the session, so a 401 means "run its sign-in again". */

const KEY = "errtraq.proxy.reload";
export const RELOAD_INTERVAL_MS = 60_000;

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * A reload is allowed when none happened within the last minute; the time is kept in
 * `sessionStorage` so a loop (the proxy keeps answering 401) turns into an error message.
 */
export function claimReload(store: Store, now: number): boolean {
  let last = 0;
  try {
    last = Number(store.getItem(KEY) ?? 0) || 0;
  } catch {
    // unreadable storage counts as "never reloaded", but the write below may fail too
  }
  if (now - last < RELOAD_INTERVAL_MS && now >= last) return false;
  try {
    store.setItem(KEY, String(now));
  } catch {
    // Cannot remember: refuse rather than risk a reload loop.
    return false;
  }
  return true;
}
