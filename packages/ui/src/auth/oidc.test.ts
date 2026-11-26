import { describe, expect, it } from "vitest";
import type { OidcClientConfig } from "./config";
import {
  beginSignIn,
  cleanCallbackUrl,
  completeSignIn,
  logoutUrl,
  type OidcDeps,
} from "./oidc";
import { challengeOf } from "./pkce";

const issuer = "https://idp.test";
const config: OidcClientConfig = {
  issuer,
  clientId: "spa",
  scopes: "openid email profile",
  tokenKind: "access",
};
const b64 = (value: unknown) =>
  btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;

function setup(
  tokenBody: (form: URLSearchParams) => Record<string, unknown> | null,
  now = 1_000_000,
) {
  const store = new Map<string, string>();
  const calls: { url: string; form?: URLSearchParams }[] = [];
  const deps: OidcDeps = {
    now: () => now,
    origin: "https://app.test",
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    fetch: (async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        calls.push({ url });
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          end_session_endpoint: `${issuer}/logout`,
        });
      }
      const form = new URLSearchParams(String(init?.body));
      calls.push({ url, form });
      const body = tokenBody(form);
      return body ? Response.json(body) : new Response("no", { status: 400 });
    }) as typeof fetch,
  };
  return { deps, store, calls };
}

describe("authorization request", () => {
  it("sends PKCE S256, state and nonce, and keeps them for the round trip only", async () => {
    const { deps, store } = setup(() => null);
    const url = new URL(await beginSignIn(config, deps));
    const q = url.searchParams;
    expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("spa");
    expect(q.get("redirect_uri")).toBe("https://app.test/auth/callback");
    expect(q.get("scope")).toBe("openid email profile");
    expect(q.get("code_challenge_method")).toBe("S256");
    const pending = JSON.parse(store.get("errtraq.oidc.pending") ?? "{}");
    expect(q.get("state")).toBe(pending.state);
    expect(q.get("nonce")).toBe(pending.nonce);
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(q.get("code_challenge")).toBe(await challengeOf(pending.verifier));
  });
  it("refuses a discovery document that names another issuer", async () => {
    const { deps } = setup(() => null);
    deps.fetch = (async () =>
      Response.json({ issuer: "https://evil.test" })) as typeof fetch;
    await expect(beginSignIn(config, deps)).rejects.toThrow(/different issuer/);
  });
});

describe("callback", () => {
  async function begin(tokenBody: Parameters<typeof setup>[0], now?: number) {
    const s = setup(tokenBody, now);
    await beginSignIn(config, s.deps);
    const pending = JSON.parse(s.store.get("errtraq.oidc.pending") ?? "{}");
    return { ...s, pending };
  }
  it("exchanges the code with the verifier and stores nothing but the token", async () => {
    let seen: URLSearchParams | undefined;
    const { deps, store, pending } = await begin((form) => {
      seen = form;
      return {
        access_token: jwt({ exp: 2_000 }),
        id_token: jwt({ nonce: pending.nonce }),
        expires_in: 300,
      };
    });
    const result = await completeSignIn(
      config,
      `?code=abc&state=${pending.state}`,
      deps,
    );
    expect(seen?.get("grant_type")).toBe("authorization_code");
    expect(seen?.get("code")).toBe("abc");
    expect(seen?.get("code_verifier")).toBe(pending.verifier);
    expect(result.expiresAt).toBe(2_000_000);
    expect(result.token.split(".")).toHaveLength(3);
    expect(store.has("errtraq.oidc.pending")).toBe(false);
  });
  it("sends the ID token when configured, and falls back to expires_in for opaque tokens", async () => {
    const { deps, pending } = await begin((form) => ({
      access_token: "opaque",
      id_token: jwt({ nonce: pending.nonce }),
      expires_in: 120,
      form: form.get("code"),
    }));
    const idConfig = { ...config, tokenKind: "id" as const };
    const id = await completeSignIn(
      idConfig,
      `?code=abc&state=${pending.state}`,
      deps,
    );
    expect(id.token).toContain(".");
    expect(id.expiresAt).toBe(1_000_000 + 120_000);
  });
  it("rejects a wrong state and consumes the pending record", async () => {
    const { deps, store, pending } = await begin(() => ({}));
    await expect(
      completeSignIn(config, "?code=abc&state=forged", deps),
    ).rejects.toThrow(/did not match/);
    expect(store.has("errtraq.oidc.pending")).toBe(false);
    // The legitimate response now fails too: a callback cannot be replayed.
    await expect(
      completeSignIn(config, `?code=abc&state=${pending.state}`, deps),
    ).rejects.toThrow(/did not match/);
  });
  it("rejects a missing code, a provider error and a stale sign-in", async () => {
    const a = await begin(() => ({}));
    await expect(
      completeSignIn(config, `?state=${a.pending.state}`, a.deps),
    ).rejects.toThrow();
    const b = await begin(() => ({}));
    await expect(
      completeSignIn(config, "?error=access_denied&state=x", b.deps),
    ).rejects.toThrow(/access_denied/);
    const c = await begin(() => ({}));
    const late = { ...c.deps, now: () => 1_000_000 + 11 * 60_000 };
    await expect(
      completeSignIn(config, `?code=abc&state=${c.pending.state}`, late),
    ).rejects.toThrow(/did not match/);
  });
  it("rejects an ID token with the wrong nonce or none", async () => {
    const wrong = await begin(() => ({
      access_token: "a",
      id_token: jwt({ nonce: "other" }),
    }));
    await expect(
      completeSignIn(
        config,
        `?code=abc&state=${wrong.pending.state}`,
        wrong.deps,
      ),
    ).rejects.toThrow(/nonce/);
    const none = await begin(() => ({ access_token: "a" }));
    await expect(
      completeSignIn(
        config,
        `?code=abc&state=${none.pending.state}`,
        none.deps,
      ),
    ).rejects.toThrow(/nonce/);
  });
  it("reports a rejected code exchange", async () => {
    const s = await begin(() => null);
    await expect(
      completeSignIn(config, `?code=abc&state=${s.pending.state}`, s.deps),
    ).rejects.toThrow(/rejected/);
  });
});

describe("callback URL cleanup", () => {
  it("drops the authorization response parameters and keeps the rest", () => {
    expect(
      cleanCallbackUrl(
        "https://app.test/auth/callback?code=a&state=b&iss=x&keep=1#frag",
      ),
    ).toBe("/auth/callback?keep=1#frag");
    expect(
      cleanCallbackUrl("https://app.test/auth/callback?code=a&state=b"),
    ).toBe("/auth/callback");
  });
});

describe("logout", () => {
  it("builds the end-session URL when the provider has one", async () => {
    const { deps } = setup(() => null);
    const url = await logoutUrl(config, deps);
    expect(url).toBe(
      `${issuer}/logout?client_id=spa&post_logout_redirect_uri=${encodeURIComponent("https://app.test/login")}`,
    );
  });
  it("returns null when discovery fails", async () => {
    const { deps } = setup(() => null);
    deps.fetch = (async () =>
      new Response("", { status: 500 })) as typeof fetch;
    expect(await logoutUrl(config, deps)).toBeNull();
  });
});
