import {
  type ApiTokenId,
  type AuthSettings,
  bootstrapProject,
  hashApiToken,
  type Org,
  type OrgId,
  type SignedProxySettings,
  type UnsignedProxySettings,
} from "@moriyoshi/errtraq-core";
import { createApiApp, type FetchLike } from "@moriyoshi/errtraq-http";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fakeFetch,
  generateKey,
  mint,
  NOW,
  pemOf,
  type TestKey,
} from "./jwt-fixtures.js";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryKV } from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

const ISS = "https://idp.example.test";
const read = ["event:read"] as const;
const write = ["event:read", "event:write"] as const;
let rsa: TestKey;
let ec: TestKey;
const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISS,
  aud: "errtraq",
  sub: "user-1",
  email: "a@example.test",
  email_verified: true,
  groups: ["viewers"],
  iat: NOW - 5,
  exp: NOW + 300,
  ...extra,
});
const oidc = (extra: Partial<AuthSettings["oidc"]> = {}): AuthSettings => ({
  oidc: {
    issuer: ISS,
    audience: "errtraq",
    jwks: { keys: [rsa.publicJwk] },
    grants: [
      { claim: "groups", value: "viewers", org: "org", scopes: [...read] },
      { claim: "groups", value: "editors", org: "org", scopes: [...write] },
    ],
    ...extra,
  } as NonNullable<AuthSettings["oidc"]>,
});

async function setup(auth?: AuthSettings, fetchFn?: FetchLike) {
  const store = new MemoryActiveStore();
  const clock = new FakeClock("2025-01-01T00:00:00.000Z");
  const boot = await bootstrapProject({
    store,
    kv: new MemoryKV(clock),
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "project",
  });
  const other: Org = { id: "org-2" as OrgId, slug: "other", name: "Other" };
  await store.projects.putOrg(other);
  await store.projects.putToken({
    id: "token" as ApiTokenId,
    orgId: boot.org.id,
    tokenHash: await hashApiToken("errtraq_secret"),
    scopes: ["event:read", "event:write"],
  });
  const app = createApiApp({
    store,
    clock,
    ...(auth ? { auth } : {}),
    ...(fetchFn ? { authFetch: fetchFn } : {}),
  });
  const call = (
    path: string,
    headers: Record<string, string> = {},
    init: RequestInit = {},
  ) =>
    Promise.resolve(
      app.request(path, {
        ...init,
        headers: { ...headers, ...(init.headers as object) },
      }),
    );
  return { app, call, store, boot };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  rsa = await generateKey("RS256", "rsa-1");
  ec = await generateKey("ES256", "ec-1");
});

describe("Bearer OIDC", () => {
  it("keeps API tokens working, with and without OIDC configured", async () => {
    for (const auth of [undefined, oidc()]) {
      const { call } = await setup(auth);
      const res = await call("/api/0/", bearer("errtraq_secret"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        user: unknown;
        auth: { scopes: string[] };
        errtraq: { principal: { kind: string } };
      };
      expect(body.user).toBeNull();
      expect(body.auth.scopes).toEqual(["event:read", "event:write"]);
      expect(body.errtraq.principal.kind).toBe("token");
      expect((await call("/api/0/", bearer("errtraq_wrong"))).status).toBe(401);
    }
  });
  it("answers 401 to a JWT when OIDC is not configured", async () => {
    const { call } = await setup();
    expect(
      (await call("/api/0/", bearer(await mint(rsa, claims())))).status,
    ).toBe(401);
  });
  it("never sends an errtraq_ token to the JWT verifier, nor looks a JWT up by hash", async () => {
    const { call } = await setup(oidc());
    expect((await call("/api/0/", bearer("errtraq_a.b.c"))).status).toBe(401);
    expect((await call("/api/0/", bearer("not-a-jwt"))).status).toBe(401);
    expect((await call("/api/0/")).status).toBe(401);
  });
  it("maps a verified JWT to the grant's organization and scopes, and reports it in whoami", async () => {
    const { call } = await setup(oidc());
    const res = await call("/api/0/", bearer(await mint(rsa, claims())));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      auth: { scopes: ["event:read"] },
      user: { id: "user-1", email: "a@example.test" },
      errtraq: { principal: { kind: "oidc" } },
    });
    const orgs = await call(
      "/api/0/organizations",
      bearer(await mint(rsa, claims())),
    );
    expect(((await orgs.json()) as { slug: string }[])[0]?.slug).toBe("org");
  });
  it("unions the scopes of several grants of one organization", async () => {
    const { call } = await setup(oidc());
    const token = await mint(rsa, claims({ groups: ["viewers", "editors"] }));
    const res = await call("/api/0/", bearer(token));
    expect(
      ((await res.json()) as { auth: { scopes: string[] } }).auth.scopes.sort(),
    ).toEqual(["event:read", "event:write"]);
  });
  it("answers 403 with no matching grant, with grants for two organizations, and for an unknown slug", async () => {
    const two = oidc();
    two.oidc?.grants.push({
      claim: "groups",
      value: "others",
      org: "other",
      scopes: [...read],
    });
    const { call } = await setup(two);
    const none = await call(
      "/api/0/",
      bearer(await mint(rsa, claims({ groups: ["x"] }))),
    );
    expect(none.status).toBe(403);
    expect(await none.json()).toEqual({
      detail: "No access is granted to this identity",
    });
    expect(
      (
        await call(
          "/api/0/",
          bearer(await mint(rsa, claims({ groups: ["viewers", "others"] }))),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "/api/0/",
          bearer(await mint(rsa, claims({ groups: ["others"] }))),
        )
      ).status,
    ).toBe(200);
    const unknown = oidc();
    unknown.oidc?.grants.push({
      claim: "groups",
      value: "ghost",
      org: "nowhere",
      scopes: [...read],
    });
    const s = await setup(unknown);
    expect(
      (
        await s.call(
          "/api/0/",
          bearer(await mint(rsa, claims({ groups: ["ghost"] }))),
        )
      ).status,
    ).toBe(403);
  });
  it("matches a scalar claim and requires email_verified for email grants", async () => {
    const settings = oidc({
      grants: [
        { claim: "hd", value: "example.test", org: "org", scopes: [...read] },
        {
          claim: "email",
          value: "boss@example.test",
          org: "org",
          scopes: [...write],
        },
      ],
    });
    const { call } = await setup(settings);
    const hd = await call(
      "/api/0/",
      bearer(await mint(rsa, claims({ hd: "example.test" }))),
    );
    expect(hd.status).toBe(200);
    const boss = { email: "Boss@Example.test", groups: undefined };
    expect(
      (
        await call(
          "/api/0/",
          bearer(await mint(rsa, claims({ ...boss, email_verified: false }))),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "/api/0/",
          bearer(await mint(rsa, claims({ ...boss, email_verified: "true" }))),
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("/api/0/", bearer(await mint(rsa, claims(boss))))).status,
    ).toBe(200);
  });
  it("still enforces the scope required by the route", async () => {
    const { call } = await setup(oidc());
    const token = await mint(rsa, claims());
    const res = await call(
      "/api/0/projects/org/project/issues/1",
      {
        ...bearer(token),
        "content-type": "application/json",
      },
      { method: "PUT", body: "{}" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: "Insufficient scope" });
  });
  it("rejects bad signatures, issuers and expiry with 401 and a fixed message", async () => {
    const { call } = await setup(oidc());
    for (const token of [
      await mint(rsa, claims(), { tamper: true }),
      await mint(rsa, claims({ iss: "https://evil.example.test" })),
      await mint(rsa, claims({ exp: NOW - 1000 })),
      await mint(rsa, claims({ aud: "other" })),
    ]) {
      const res = await call("/api/0/", bearer(token));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ detail: "Invalid token" });
    }
  });
  it("fetches keys through the injected fetch and fails closed when the IdP is down", async () => {
    const jwksUri = `${ISS}/jwks`;
    const f = fakeFetch({
      [`${ISS}/.well-known/openid-configuration`]: () => ({
        body: JSON.stringify({ issuer: ISS, jwks_uri: jwksUri }),
      }),
      [jwksUri]: () => ({ body: JSON.stringify({ keys: [rsa.publicJwk] }) }),
    });
    const settings = oidc();
    delete settings.oidc?.jwks;
    const { call } = await setup(settings, f.fetch);
    expect(
      (await call("/api/0/", bearer(await mint(rsa, claims())))).status,
    ).toBe(200);
    const down = await setup(settings, fakeFetch({}).fetch);
    expect(
      (await down.call("/api/0/", bearer(await mint(rsa, claims())))).status,
    ).toBe(401);
  });
});

describe("signed proxy assertions", () => {
  const grants = [
    { claim: "email", value: "a@example.test", org: "org", scopes: [...write] },
  ];
  const proxy = (extra: Partial<SignedProxySettings>): AuthSettings => ({
    proxy: { kind: "signed", grants, ...extra } as SignedProxySettings,
  });
  const csrfWrite = {
    "x-errtraq-csrf": "1",
    "content-type": "application/json",
  };

  it("Google IAP: ES256 in x-goog-iap-jwt-assertion, iss https://cloud.google.com/iap, audience path", async () => {
    const aud = "/projects/123/global/backendServices/456";
    const auth = proxy({
      preset: "google-iap",
      audience: aud,
      jwks: { keys: [ec.publicJwk] },
    });
    const { call } = await setup(auth);
    const iap = {
      iss: "https://cloud.google.com/iap",
      aud,
      sub: "accounts.google.com:1",
      email: "a@example.test",
      iat: NOW - 5,
      exp: NOW + 300,
    };
    const ok = await call("/api/0/", {
      "x-goog-iap-jwt-assertion": await mint(ec, iap),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      errtraq: { principal: { kind: "proxy" } },
      user: { email: "a@example.test" },
    });
    for (const bad of [
      { ...iap, aud: "/projects/1/global/backendServices/9" },
      { ...iap, iss: "https://accounts.google.com" },
      { ...iap, exp: NOW - 500 },
    ])
      expect(
        (
          await call("/api/0/", {
            "x-goog-iap-jwt-assertion": await mint(ec, bad),
          })
        ).status,
      ).toBe(401);
    // RS256 is not an IAP algorithm.
    expect(
      (
        await call("/api/0/", {
          "x-goog-iap-jwt-assertion": await mint(rsa, iap),
        })
      ).status,
    ).toBe(401);
  });
  it("Google IAP preset fetches the documented key URL", async () => {
    const aud = "/projects/1/locations/r/services/s";
    const f = fakeFetch({
      "https://www.gstatic.com/iap/verify/public_key-jwk": () => ({
        body: JSON.stringify({ keys: [ec.publicJwk] }),
      }),
    });
    const { call } = await setup(
      proxy({ preset: "google-iap", audience: aud }),
      f.fetch,
    );
    const token = await mint(ec, {
      iss: "https://cloud.google.com/iap",
      aud,
      email: "a@example.test",
      iat: NOW,
      exp: NOW + 300,
    });
    expect(
      (await call("/api/0/", { "x-goog-iap-jwt-assertion": token })).status,
    ).toBe(200);
    expect(f.calls).toEqual([
      "https://www.gstatic.com/iap/verify/public_key-jwk",
    ]);
  });
  it("Cloudflare Access: RS256 in cf-access-jwt-assertion, certs under the team domain", async () => {
    const aud = "abc123tag";
    const iss = "https://acme.cloudflareaccess.com";
    const f = fakeFetch({
      [`${iss}/cdn-cgi/access/certs`]: () => ({
        body: JSON.stringify({
          keys: [rsa.publicJwk],
          public_cert: {},
          public_certs: [],
        }),
      }),
    });
    const { call } = await setup(
      proxy({ preset: "cloudflare-access", team: "acme", audience: aud }),
      f.fetch,
    );
    const cf = {
      iss,
      aud: [aud],
      email: "a@example.test",
      iat: NOW,
      exp: NOW + 300,
    };
    expect(
      (
        await call("/api/0/", {
          "cf-access-jwt-assertion": await mint(rsa, cf),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("/api/0/", {
          "cf-access-jwt-assertion": await mint(rsa, { ...cf, aud: ["other"] }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("/api/0/", {
          "cf-access-jwt-assertion": await mint(rsa, {
            ...cf,
            iss: "https://evil.cloudflareaccess.com",
          }),
        })
      ).status,
    ).toBe(401);
  });
  describe("AWS ALB", () => {
    const signer =
      "arn:aws:elasticloadbalancing:eu-west-1:123456789012:loadbalancer/app/web/abc";
    const keyUrl = "https://public-keys.auth.elb.eu-west-1.amazonaws.com/ec-1";
    const alb = {
      sub: "s1",
      email: "a@example.test",
      email_verified: true,
      exp: NOW + 60,
      iss: "https://idp.example.test",
    };
    const setupAlb = async (extra: Partial<SignedProxySettings> = {}) => {
      const pem = await pemOf(ec);
      const f = fakeFetch({ [keyUrl]: () => ({ body: pem }) });
      return {
        ...(await setup(
          proxy({ preset: "aws-alb", signer, ...extra }),
          f.fetch,
        )),
        f,
      };
    };
    it("verifies a padded standard-base64 ES256 token against the PEM fetched by kid", async () => {
      const { call, f } = await setupAlb();
      const token = await mint(ec, alb, {
        albEncoding: true,
        header: { signer, iss: alb.iss, client: "c" },
      });
      expect(token).toMatch(/=/);
      expect(
        (await call("/api/0/", { "x-amzn-oidc-data": token })).status,
      ).toBe(200);
      expect(
        (await call("/api/0/", { "x-amzn-oidc-data": token })).status,
      ).toBe(200);
      expect(f.calls).toEqual([keyUrl]);
    });
    it("rejects a wrong signer, an expired token and a bad signature", async () => {
      const { call } = await setupAlb();
      const header = { signer, iss: alb.iss };
      const wrong = await mint(ec, alb, {
        albEncoding: true,
        header: { ...header, signer: signer.replace("web", "other") },
      });
      const old = await mint(
        ec,
        { ...alb, exp: NOW - 600 },
        { albEncoding: true, header },
      );
      const forged = await mint(ec, alb, {
        albEncoding: true,
        header,
        tamper: true,
      });
      for (const t of [wrong, old, forged])
        expect((await call("/api/0/", { "x-amzn-oidc-data": t })).status).toBe(
          401,
        );
    });
    it("uses the header exp when the payload carries none", async () => {
      const { call } = await setupAlb();
      const { exp: _exp, ...noExp } = alb;
      const token = await mint(ec, noExp, {
        albEncoding: true,
        header: { signer, exp: String(NOW + 60) },
      });
      expect(
        (await call("/api/0/", { "x-amzn-oidc-data": token })).status,
      ).toBe(200);
    });
    it("requires the signer and a keyUrl for a non-commercial ARN", () => {
      expect(() =>
        createApiApp({
          store: new MemoryActiveStore(),
          clock: new FakeClock(),
          auth: proxy({
            preset: "aws-alb",
            audience: "x",
            signer:
              "arn:aws-us-gov:elasticloadbalancing:us-gov-west-1:123456789012:loadbalancer/app/a/b",
          }),
        }),
      ).toThrow(/keyUrl/);
    });
  });
  it("Pomerium: assertion header, service-domain audience and issuer, JWKS under /.well-known/pomerium", async () => {
    const host = "errtraq.corp.example.test";
    const f = fakeFetch({
      [`https://${host}/.well-known/pomerium/jwks.json`]: () => ({
        body: JSON.stringify({ keys: [ec.publicJwk] }),
      }),
    });
    const { call } = await setup(
      proxy({ preset: "pomerium", audience: host }),
      f.fetch,
    );
    const p = {
      iss: host,
      aud: host,
      sub: "u",
      email: "a@example.test",
      iat: NOW,
      exp: NOW + 300,
    };
    expect(
      (await call("/api/0/", { "x-pomerium-jwt-assertion": await mint(ec, p) }))
        .status,
    ).toBe(200);
    expect(
      (
        await call("/api/0/", {
          "x-pomerium-jwt-assertion": await mint(ec, {
            ...p,
            aud: "x.example.test",
          }),
        })
      ).status,
    ).toBe(401);
  });
  it("generic: any header with its own key source", async () => {
    const { call } = await setup(
      proxy({
        preset: "generic",
        header: "x-assert",
        issuer: ISS,
        audience: "errtraq",
        jwks: { keys: [rsa.publicJwk] },
        assumeEmailVerified: true,
      }),
    );
    const t = await mint(rsa, claims({ email_verified: undefined }));
    expect((await call("/api/0/", { "x-assert": t })).status).toBe(200);
  });
  it("does not trust the email of a proxy that does not assert verification unless told to", async () => {
    const { call } = await setup(
      proxy({
        preset: "generic",
        header: "x-assert",
        issuer: ISS,
        audience: "errtraq",
        jwks: { keys: [rsa.publicJwk] },
      }),
    );
    expect(
      (
        await call("/api/0/", {
          "x-assert": await mint(rsa, claims({ email_verified: undefined })),
        })
      ).status,
    ).toBe(403);
  });

  it("requires the CSRF header and a JSON content type for proxy writes only", async () => {
    const auth: AuthSettings = {
      ...proxy({
        preset: "generic",
        header: "x-assert",
        issuer: ISS,
        audience: "errtraq",
        jwks: { keys: [rsa.publicJwk] },
        assumeEmailVerified: true,
      }),
    };
    const { call, boot } = await setup(auth);
    const assertion = { "x-assert": await mint(rsa, claims()) };
    const url = `/api/0/projects/org/project/issues/nope`;
    const put = (headers: Record<string, string>) =>
      call(url, { ...assertion, ...headers }, { method: "PUT", body: "{}" });
    expect((await put({})).status).toBe(403);
    expect(
      (await put({ "x-errtraq-csrf": "1", "content-type": "text/plain" }))
        .status,
    ).toBe(403);
    expect(
      (await put({ "x-errtraq-csrf": "0", "content-type": "application/json" }))
        .status,
    ).toBe(403);
    // Past the CSRF check the request reaches the route (404 for an unknown issue).
    expect((await put(csrfWrite)).status).not.toBe(403);
    expect(((await (await put({})).json()) as { detail: string }).detail).toBe(
      "CSRF check failed",
    );
    // Reads and Bearer API tokens are unaffected.
    expect((await call("/api/0/", assertion)).status).toBe(200);
    const token = await call(url, bearer("errtraq_secret"), {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "text/plain" },
    });
    expect(token.status).not.toBe(403);
    void boot;
  });

  it("precedence: errtraq_ token, then the proxy, then a Bearer JWT; a failed assertion is final", async () => {
    const auth: AuthSettings = {
      ...oidc(),
      ...proxy({
        preset: "generic",
        header: "x-assert",
        issuer: ISS,
        audience: "errtraq",
        jwks: { keys: [ec.publicJwk] },
        assumeEmailVerified: true,
      }),
    };
    const { call } = await setup(auth);
    const jwt = await mint(rsa, claims());
    const good = await mint(ec, claims({ sub: "proxy-user" }));
    const bad = await mint(ec, claims({ sub: "proxy-user" }), { tamper: true });
    const kindOf = async (h: Record<string, string>) =>
      (
        (await (await call("/api/0/", h)).json()) as {
          errtraq?: { principal: { kind: string } };
        }
      ).errtraq?.principal.kind;
    expect(
      await kindOf({ ...bearer("errtraq_secret"), "x-assert": good }),
    ).toBe("token");
    expect(await kindOf({ ...bearer(jwt), "x-assert": good })).toBe("proxy");
    expect(await kindOf(bearer(jwt))).toBe("oidc");
    // A forged assertion is a 401 even beside a valid Bearer JWT.
    expect(
      (await call("/api/0/", { ...bearer(jwt), "x-assert": bad })).status,
    ).toBe(401);
    // An errtraq_ token that is wrong stays 401 whatever else is present.
    expect(
      (await call("/api/0/", { ...bearer("errtraq_nope"), "x-assert": good }))
        .status,
    ).toBe(401);
    // An unconfigured header is never read.
    expect(
      (await call("/api/0/", { "x-goog-iap-jwt-assertion": good })).status,
    ).toBe(401);
  });
});

describe("unsigned identity headers", () => {
  const secret = "s3cret-shared-value-123";
  const grants = [
    { claim: "groups", value: "ops", org: "org", scopes: [...write] },
  ];
  const unsigned = (
    extra: Partial<UnsignedProxySettings> = {},
  ): AuthSettings => ({
    proxy: {
      kind: "unsigned",
      trustUnsignedHeaders: true,
      preset: "oauth2-proxy",
      secretHeader: "x-errtraq-proxy-secret",
      secret,
      grants,
      ...extra,
    },
  });
  const forwarded = {
    "x-forwarded-user": "alice",
    "x-forwarded-email": "alice@example.test",
    "x-forwarded-groups": " dev , ops,, ",
  };
  it("accepts oauth2-proxy headers carrying the shared secret", async () => {
    const { call } = await setup(unsigned());
    const res = await call("/api/0/", {
      ...forwarded,
      "x-errtraq-proxy-secret": secret,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      user: { id: "alice" },
      errtraq: { principal: { kind: "proxy" } },
    });
  });
  it("answers 401 to forged headers: no secret, a wrong secret, a prefix, a longer secret", async () => {
    const { call } = await setup(unsigned());
    for (const headers of [
      forwarded,
      { ...forwarded, "x-errtraq-proxy-secret": "wrong" },
      { ...forwarded, "x-errtraq-proxy-secret": secret.slice(0, -1) },
      { ...forwarded, "x-errtraq-proxy-secret": `${secret}x` },
      { "x-errtraq-proxy-secret": secret },
    ])
      expect((await call("/api/0/", headers)).status).toBe(401);
  });
  it("does not fall through to a Bearer JWT when forged headers are present", async () => {
    const both: AuthSettings = { ...oidc(), ...unsigned() };
    const { call } = await setup(both);
    const jwt = await mint(rsa, claims());
    expect(
      (await call("/api/0/", { ...bearer(jwt), ...forwarded })).status,
    ).toBe(401);
    expect((await call("/api/0/", bearer(jwt))).status).toBe(200);
  });
  it("caps the group list (count and length) before matching", async () => {
    const { call } = await setup(unsigned());
    const many = [
      ...Array.from({ length: 150 }, (_, i) => `g${i}`),
      "ops",
    ].join(",");
    const res = await call("/api/0/", {
      ...forwarded,
      "x-forwarded-groups": many,
      "x-errtraq-proxy-secret": secret,
    });
    expect(res.status).toBe(403);
    const long = await call("/api/0/", {
      ...forwarded,
      "x-forwarded-groups": `${"o".repeat(300)}`,
      "x-errtraq-proxy-secret": secret,
    });
    expect(long.status).toBe(403);
  });
  it("decodes Azure App Service X-MS-CLIENT-PRINCIPAL (base64 JSON) and role_typ", async () => {
    const principal = btoa(
      JSON.stringify({
        auth_typ: "aad",
        name_typ: "name",
        role_typ:
          "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
        claims: [
          { typ: "groups", val: "g-1" },
          { typ: "groups", val: "g-ops" },
          {
            typ: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
            val: "Reader",
          },
        ],
      }),
    );
    const azure = (claim: string, value: string) =>
      setup(
        unsigned({
          preset: "azure-app-service",
          grants: [{ claim, value, org: "org", scopes: [...read] }],
        }),
      );
    const headers = {
      "x-ms-client-principal": principal,
      "x-ms-client-principal-id": "oid-1",
      "x-errtraq-proxy-secret": secret,
    };
    expect(
      (await (await azure("groups", "g-ops")).call("/api/0/", headers)).status,
    ).toBe(200);
    expect(
      (await (await azure("roles", "Reader")).call("/api/0/", headers)).status,
    ).toBe(200);
    expect(
      (
        await (
          await azure("groups", "g-ops")
        ).call("/api/0/", { ...headers, "x-errtraq-proxy-secret": "no" })
      ).status,
    ).toBe(401);
  });
  it("supports a custom header-to-claim mapping and emailVerified", async () => {
    const { call } = await setup(
      unsigned({
        preset: "custom",
        mapping: [
          { header: "x-user", claim: "sub" },
          { header: "x-mail", claim: "email" },
        ],
        emailVerified: true,
        grants: [
          {
            claim: "email",
            value: "bob@example.test",
            org: "org",
            scopes: [...read],
          },
        ],
      }),
    );
    const res = await call("/api/0/", {
      "x-user": "bob",
      "x-mail": "bob@example.test",
      "x-errtraq-proxy-secret": secret,
    });
    expect(res.status).toBe(200);
  });
});
