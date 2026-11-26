import { createSignal } from "solid-js";
import { authMode } from "./config";
import type { OidcDeps } from "./oidc";
import { claimReload } from "./proxy";

/** Browser bindings for the pure sign-in functions. */
export function browserOidcDeps(): OidcDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    storage: sessionStorage,
    origin: location.origin,
    now: () => Date.now(),
  };
}

const [proxyFailure, setProxyFailure] = createSignal<string | null>(null);

export { proxyFailure };

/**
 * Proxy mode, after a 401: the proxy session ended or never existed, so reload the page and let
 * the proxy run its own sign-in. At most once a minute; after that show an error instead of looping.
 */
export function proxyUnauthorized(): void {
  if (authMode !== "proxy") return;
  let store: Storage | undefined;
  try {
    store = sessionStorage;
  } catch {
    store = undefined;
  }
  if (store && claimReload(store, Date.now())) {
    location.reload();
    return;
  }
  setProxyFailure(
    "Your session with the sign-in proxy ended and could not be renewed. Reload this page to try again.",
  );
}
