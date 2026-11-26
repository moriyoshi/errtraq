import { useQueryClient } from "@tanstack/solid-query";
import { createRoute, redirect, useNavigate } from "@tanstack/solid-router";
import { createSignal, Show } from "solid-js";
import { isApiError } from "../api/errors";
import { api } from "../api/instance";
import { whoamiSchema } from "../api/schemas";
import { browserOidcDeps } from "../auth/app";
import { authMode, oidcConfig } from "../auth/config";
import { beginSignIn } from "../auth/oidc";
import { isSignedIn, saveToken } from "../auth/session";
import { rootRoute } from "./root";

function Login() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const sso = async () => {
    if (!oidcConfig) return;
    setBusy(true);
    setError(null);
    try {
      location.assign(await beginSignIn(oidcConfig, browserOidcDeps()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the sign-in.");
      setBusy(false);
    }
  };
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const candidate = value().trim();
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      // `whoami` is the cheapest authenticated route; a 401 here means a bad token.
      await api.get("/api/0/", whoamiSchema, {
        token: candidate,
        quiet401: true,
      });
      qc.clear();
      saveToken(candidate);
      await navigate({ to: "/organizations" });
    } catch (e) {
      setError(
        isApiError(e, "unauthorized")
          ? "That token was not accepted."
          : e instanceof Error
            ? e.message
            : "Login failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="card login" onSubmit={submit}>
      <h1>Sign in</h1>
      <Show when={oidcConfig}>
        <button type="button" class="primary" disabled={busy()} onClick={sso}>
          Sign in with single sign-on
        </button>
        <p class="muted">Or use an API token.</p>
      </Show>
      <p class="muted">
        Paste an API token. It stays in this tab's session storage and is sent
        as a Bearer token.
      </p>
      <label for="token">API token</label>
      <input
        id="token"
        name="token"
        type="password"
        autocomplete="off"
        spellcheck={false}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
      />
      <Show when={error()}>
        <p class="notice error" role="alert">
          {error()}
        </p>
      </Show>
      <button
        type="submit"
        class="primary"
        disabled={busy() || !value().trim()}
      >
        {busy() ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: () => {
    if (authMode === "proxy" || isSignedIn())
      throw redirect({ to: "/organizations" });
  },
  component: Login,
});
