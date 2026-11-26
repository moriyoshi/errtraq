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
import { clearToken, peekToken, token } from "../auth/session";
import { ErrorNotice, Loading } from "../components/common";

function RootLayout() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = () => {
    clearToken();
    qc.clear();
    void navigate({ to: "/login" });
  };
  return (
    <>
      <header class="topbar">
        <Link to="/organizations" class="brand">
          errtraq
        </Link>
        <Show when={token()}>
          <button type="button" class="link" onClick={logout}>
            Log out
          </button>
        </Show>
      </header>
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
    throw redirect({ to: peekToken() ? "/organizations" : "/login" });
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
          fallback={<Loading label="Checking your token…" />}
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
    if (!peekToken()) throw redirect({ to: "/login" });
  },
  component: Authed,
});
