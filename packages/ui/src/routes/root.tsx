import { useQueryClient } from "@tanstack/solid-query";
import {
  createRootRoute,
  createRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
} from "@tanstack/solid-router";
import { Show } from "solid-js";
import { useWhoami } from "../api/queries";
import { browserOidcDeps, proxyFailure } from "../auth/app";
import { authMode, oidcConfig, proxyLogoutUrl } from "../auth/config";
import { logoutUrl } from "../auth/oidc";
import { clearToken, isSignedIn, token } from "../auth/session";
import { ErrorNotice, Loading } from "../components/common";
import { HeaderTools } from "../components/HeaderTools";

function RootLayout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = async () => {
    clearToken();
    qc.clear();
    if (authMode === "proxy") {
      if (proxyLogoutUrl) location.assign(proxyLogoutUrl);
      return;
    }
    // The provider session ends too when it publishes an end-session endpoint.
    const end = oidcConfig
      ? await logoutUrl(oidcConfig, browserOidcDeps())
      : null;
    if (end) location.assign(end);
    else void navigate({ to: "/login" });
  };
  return (
    <>
      <header class="topbar">
        <Link to="/organizations" class="brand">
          errtraq
        </Link>
        <HeaderTools />
        <Show when={authMode === "proxy" ? !!proxyLogoutUrl : token()}>
          <button type="button" class="link" onClick={logout}>
            Log out
          </button>
        </Show>
      </header>
      <Show when={proxyFailure()}>
        <p class="notice error" role="alert">
          {proxyFailure()}
        </p>
      </Show>
      <main class="page">
        <Outlet />
      </main>
    </>
  );
}

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <div class="notice">
      Nothing here. <Link to="/organizations">Go to your organizations</Link>.
    </div>
  ),
});

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: isSignedIn() ? "/organizations" : "/login" });
  },
});

function Authed() {
  const whoami = useWhoami();
  return (
    <Show
      when={whoami.data}
      fallback={
        <Show
          when={whoami.isError}
          fallback={<Loading label="Checking your sign-in…" />}
        >
          <ErrorNotice error={whoami.error} retry={() => whoami.refetch()} />
        </Show>
      }
    >
      <Outlet />
    </Show>
  );
}

/** Layout route that sends visitors without a token to the login page. */
export const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: () => {
    if (!isSignedIn()) throw redirect({ to: "/login" });
  },
  component: Authed,
});
