import { createRoute, Link, useNavigate } from "@tanstack/solid-router";
import { createSignal, onMount, Show } from "solid-js";
import { browserOidcDeps } from "../auth/app";
import { oidcConfig } from "../auth/config";
import { cleanCallbackUrl, completeSignIn } from "../auth/oidc";
import { saveToken } from "../auth/session";
import { Loading } from "../components/common";
import { rootRoute } from "./root";

function Callback() {
  const navigate = useNavigate();
  const [error, setError] = createSignal<string | null>(null);
  onMount(async () => {
    const search = location.search;
    // The code is single use and must not stay in the address bar or the history.
    history.replaceState(null, "", cleanCallbackUrl(location.href));
    if (!oidcConfig) {
      setError("Single sign-on is not configured.");
      return;
    }
    try {
      const signedIn = await completeSignIn(
        oidcConfig,
        search,
        browserOidcDeps(),
      );
      saveToken(signedIn.token, signedIn.expiresAt);
      await navigate({ to: "/organizations", replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    }
  });
  return (
    <div class="card login">
      <Show when={error()} fallback={<Loading label="Signing you in…" />}>
        <p class="notice error" role="alert">
          {error()}
        </p>
        <Link to="/login">Back to sign in</Link>
      </Show>
    </div>
  );
}

/** The redirect URI of the Authorization Code flow: `${origin}/auth/callback`. */
export const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/auth/callback",
  component: Callback,
});
