import {
  AuthError,
  cacheTtlSec,
  JwksKeySource,
  PemKidKeySource,
  type VerifyRules,
  verifyJwt,
} from "@moriyoshi/errtraq-http";
import { beforeAll, describe, expect, it } from "vitest";
import {
  fakeFetch,
  generateKey,
  mint,
  NOW,
  pemOf,
  type TestKey,
  unsignedToken,
} from "./jwt-fixtures.js";

const ISS = "https://idp.example.test";
let rsa: TestKey;
let rsa2: TestKey;
let ec: TestKey;
let ps: TestKey;
const base = () => ({
  iss: ISS,
  aud: "errtraq",
  sub: "u1",
  iat: NOW - 10,
  exp: NOW + 600,
});
const rules = (extra: Partial<VerifyRules> = {}): VerifyRules => ({
  algorithms: ["RS256", "ES256"],
  issuer: ISS,
  audience: "errtraq",
  now: () => NOW,
  ...extra,
});
const inline = (...keys: TestKey[]) =>
  new JwksKeySource({
    jwks: { keys: keys.map((k) => k.publicJwk) },
    now: () => NOW,
  });
async function rejects(promise: Promise<unknown>, reason?: RegExp) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthError);
  if (reason) expect((error as AuthError).reason).toMatch(reason);
}

beforeAll(async () => {
  rsa = await generateKey("RS256", "rsa-1");
  rsa2 = await generateKey("RS256", "rsa-2");
  ec = await generateKey("ES256", "ec-1");
  ps = await generateKey("PS256", "ps-1");
});

describe("algorithms", () => {
  it("accepts RS256, ES256 and PS256 when configured", async () => {
    const all = rules({ algorithms: ["RS256", "ES256", "PS256"] });
    for (const key of [rsa, ec, ps])
      await expect(
        verifyJwt(await mint(key, base()), inline(rsa, ec, ps), all),
      ).resolves.toMatchObject({ claims: { sub: "u1" } });
  });
  it("does not accept PS256 unless configured", async () => {
    await rejects(
      verifyJwt(await mint(ps, base()), inline(ps), rules()),
      /alg not accepted/,
    );
  });
  it("rejects none, HS256 and crit", async () => {
    await rejects(
      verifyJwt(unsignedToken("none", base()), inline(rsa), rules()),
      /alg none/,
    );
    await rejects(
      verifyJwt(unsignedToken("HS256", base()), inline(rsa), rules()),
      /symmetric/,
    );
    await rejects(
      verifyJwt(
        await mint(rsa, base(), { header: { crit: ["exp"] } }),
        inline(rsa),
        rules(),
      ),
      /crit/,
    );
  });
  it("rejects a tampered signature", async () => {
    await rejects(
      verifyJwt(
        await mint(rsa, base(), { tamper: true }),
        inline(rsa),
        rules(),
      ),
      /bad signature/,
    );
  });
  it("needs a kid when the key set has several keys, not when it has one", async () => {
    const noKid = await mint(rsa, base(), { header: { kid: undefined } });
    await rejects(verifyJwt(noKid, inline(rsa, rsa2), rules()), /kid required/);
    await expect(verifyJwt(noKid, inline(rsa), rules())).resolves.toBeDefined();
  });
  it("rejects a key whose kty, alg or use does not fit the token alg", async () => {
    const token = await mint(ec, base(), { header: { kid: "rsa-1" } });
    await rejects(
      verifyJwt(token, inline(rsa), rules()),
      /not usable|mismatch/,
    );
    const wrongAlg = {
      ...rsa.publicJwk,
      alg: "RS384",
    };
    await rejects(
      verifyJwt(
        await mint(rsa, base()),
        new JwksKeySource({ jwks: { keys: [wrongAlg] }, now: () => NOW }),
        rules(),
      ),
      /not usable/,
    );
    const enc = { ...rsa.publicJwk, use: "enc" };
    await rejects(
      verifyJwt(
        await mint(rsa, base()),
        new JwksKeySource({ jwks: { keys: [enc] }, now: () => NOW }),
        rules(),
      ),
      /not usable/,
    );
  });
  it("does not let a token signed by another key through", async () => {
    await rejects(
      verifyJwt(
        await mint(rsa2, base(), { header: { kid: "rsa-1" } }),
        inline(rsa),
        rules(),
      ),
      /bad signature/,
    );
  });
});

describe("claims", () => {
  const check = (
    claims: Record<string, unknown>,
    extra?: Partial<VerifyRules>,
  ) => mint(rsa, claims).then((t) => verifyJwt(t, inline(rsa), rules(extra)));
  it("checks the issuer exactly", async () => {
    await rejects(check({ ...base(), iss: `${ISS}/` }), /issuer/);
  });
  it("checks aud as a string or an array", async () => {
    await expect(
      check({ ...base(), aud: ["x", "errtraq"] }),
    ).resolves.toBeDefined();
    await rejects(check({ ...base(), aud: "other" }), /audience/);
    await rejects(check({ ...base(), aud: undefined }), /audience/);
  });
  it("checks a named audience claim (Cognito client_id)", async () => {
    const claims = { ...base(), aud: undefined, client_id: "errtraq" };
    await expect(
      check(claims, { audienceClaim: "client_id" }),
    ).resolves.toBeDefined();
    await rejects(check(claims), /audience/);
  });
  it("requires exp and rejects expired tokens beyond the 60 s skew", async () => {
    await rejects(check({ ...base(), exp: undefined }), /missing exp/);
    await rejects(check({ ...base(), exp: NOW - 61 }), /expired/);
    await expect(check({ ...base(), exp: NOW - 30 })).resolves.toBeDefined();
  });
  it("honours nbf and iat", async () => {
    await rejects(check({ ...base(), nbf: NOW + 120 }), /not yet valid/);
    await expect(check({ ...base(), nbf: NOW + 30 })).resolves.toBeDefined();
    await rejects(check({ ...base(), iat: NOW + 120 }), /future/);
  });
  it("bounds the lifetime from iat, and the remaining life without iat", async () => {
    await rejects(check({ ...base(), exp: NOW + 90000 }), /lifetime/);
    await rejects(
      check({ ...base(), iat: undefined, exp: NOW + 90000 }),
      /lifetime/,
    );
    await rejects(check(base(), { maxLifetimeSec: 300 }), /lifetime/);
    await expect(
      check({ ...base(), exp: NOW + 280 }, { maxLifetimeSec: 300 }),
    ).resolves.toBeDefined();
  });
  it("applies the token_use and typ checks when configured", async () => {
    const tokenUse = { claim: "token_use", value: "access" };
    await rejects(
      check({ ...base(), token_use: "id" }, { tokenUse }),
      /token use/,
    );
    await expect(
      check({ ...base(), token_use: "access" }, { tokenUse }),
    ).resolves.toBeDefined();
    await rejects(check(base(), { typ: ["at+jwt"] }), /typ/);
    const typed = await mint(rsa, base(), { header: { typ: "AT+JWT" } });
    await expect(
      verifyJwt(typed, inline(rsa), rules({ typ: ["at+jwt"] })),
    ).resolves.toBeDefined();
  });
});

describe("JWKS fetching and caching", () => {
  const jwksUri = `${ISS}/jwks`;
  const serve = (keys: () => TestKey[], cache?: string) =>
    fakeFetch({
      [jwksUri]: () => ({
        body: JSON.stringify({ keys: keys().map((k) => k.publicJwk) }),
        ...(cache ? { headers: { "cache-control": cache } } : {}),
      }),
    });
  it("fetches once and serves later tokens from the cache", async () => {
    const f = serve(() => [rsa]);
    let t = NOW;
    const source = new JwksKeySource({ jwksUri, fetch: f.fetch, now: () => t });
    const token = await mint(rsa, base());
    await verifyJwt(token, source, rules({ now: () => t }));
    t += 100;
    await verifyJwt(token, source, rules({ now: () => t }));
    expect(f.calls).toHaveLength(1);
  });
  it("refetches an unknown kid once and then rate limits per instance", async () => {
    let keys = [rsa];
    const f = serve(() => keys);
    let t = NOW;
    const source = new JwksKeySource({ jwksUri, fetch: f.fetch, now: () => t });
    await verifyJwt(await mint(rsa, base()), source, rules({ now: () => t }));
    expect(f.calls).toHaveLength(1);
    // Within the interval a forged kid cannot trigger another fetch.
    const forged = await mint(rsa2, base(), { header: { kid: "nope" } });
    t += 10;
    await rejects(
      verifyJwt(forged, source, rules({ now: () => t })),
      /unknown kid/,
    );
    await rejects(
      verifyJwt(forged, source, rules({ now: () => t })),
      /unknown kid/,
    );
    expect(f.calls).toHaveLength(1);
    // After the interval one refetch picks up the rotated key.
    keys = [rsa, rsa2];
    t += 61;
    await verifyJwt(await mint(rsa2, base()), source, rules({ now: () => t }));
    expect(f.calls).toHaveLength(2);
    // And a still-unknown kid costs exactly one more fetch, then none.
    t += 61;
    await rejects(
      verifyJwt(forged, source, rules({ now: () => t })),
      /unknown kid/,
    );
    await rejects(
      verifyJwt(forged, source, rules({ now: () => t })),
      /unknown kid/,
    );
    expect(f.calls).toHaveLength(3);
  });
  it("never refetches an inline key set", async () => {
    const f = serve(() => [rsa]);
    const source = new JwksKeySource({
      jwks: { keys: [rsa.publicJwk] },
      jwksUri,
      fetch: f.fetch,
      now: () => NOW,
    });
    await rejects(
      verifyJwt(await mint(rsa2, base()), source, rules()),
      /unknown kid/,
    );
    expect(f.calls).toHaveLength(0);
  });
  it("clamps the Cache-Control TTL to 5 minutes through 24 hours", () => {
    expect(cacheTtlSec("max-age=10")).toBe(300);
    expect(cacheTtlSec("public, max-age=7200")).toBe(7200);
    expect(cacheTtlSec("max-age=999999999")).toBe(86400);
    expect(cacheTtlSec("no-store")).toBe(3600);
    expect(cacheTtlSec(null)).toBe(3600);
  });
  it("expires the cache after the TTL", async () => {
    const f = serve(() => [rsa], "max-age=10");
    let t = NOW;
    const source = new JwksKeySource({ jwksUri, fetch: f.fetch, now: () => t });
    const token = await mint(rsa, { ...base(), exp: NOW + 4000 });
    await verifyJwt(token, source, rules({ now: () => t }));
    t += 299;
    await verifyJwt(token, source, rules({ now: () => t }));
    expect(f.calls).toHaveLength(1);
    t += 2;
    await verifyJwt(token, source, rules({ now: () => t }));
    expect(f.calls).toHaveLength(2);
  });
  it("fails closed when the fetch fails, and does not hammer the IdP", async () => {
    const failures: string[] = [];
    const f = fakeFetch({});
    const t = NOW;
    const source = new JwksKeySource({
      jwksUri,
      fetch: f.fetch,
      now: () => t,
      onFetchFailure: (c) => failures.push(c),
    });
    const token = await mint(rsa, base());
    await rejects(verifyJwt(token, source, rules({ now: () => t })));
    await rejects(verifyJwt(token, source, rules({ now: () => t })));
    expect(f.calls).toHaveLength(1);
    expect(failures).toEqual(["key fetch status"]);
  });
  it("discovers the jwks_uri and rejects a different issuer in the document", async () => {
    const discovery = `${ISS}/.well-known/openid-configuration`;
    const good = fakeFetch({
      [discovery]: () => ({
        body: JSON.stringify({ issuer: ISS, jwks_uri: jwksUri }),
      }),
      [jwksUri]: () => ({ body: JSON.stringify({ keys: [rsa.publicJwk] }) }),
    });
    const source = new JwksKeySource({
      issuer: ISS,
      fetch: good.fetch,
      now: () => NOW,
    });
    await verifyJwt(await mint(rsa, base()), source, rules());
    expect(good.calls).toEqual([discovery, jwksUri]);
    const bad = fakeFetch({
      [discovery]: () => ({
        body: JSON.stringify({
          issuer: "https://evil.example.test",
          jwks_uri: jwksUri,
        }),
      }),
      [jwksUri]: () => ({ body: JSON.stringify({ keys: [rsa.publicJwk] }) }),
    });
    await rejects(
      verifyJwt(
        await mint(rsa, base()),
        new JwksKeySource({ issuer: ISS, fetch: bad.fetch, now: () => NOW }),
        rules(),
      ),
      /discovery issuer mismatch/,
    );
    expect(bad.calls).toEqual([discovery]);
  });
});

describe("PEM by kid (ALB style)", () => {
  it("imports an SPKI PEM and caches it per kid", async () => {
    const url = "https://keys.example.test/{kid}";
    const f = fakeFetch({
      "https://keys.example.test/ec-1": () => ({ body: "" }),
    });
    const pem = await pemOf(ec);
    const served = fakeFetch({
      "https://keys.example.test/ec-1": () => ({ body: pem }),
    });
    void f;
    const source = new PemKidKeySource({
      urlTemplate: url,
      fetch: served.fetch,
      now: () => NOW,
    });
    const token = await mint(ec, base());
    await verifyJwt(token, source, rules());
    await verifyJwt(token, source, rules());
    expect(served.calls).toEqual(["https://keys.example.test/ec-1"]);
  });
  it("refuses a kid that is not a plain identifier and rate limits forged kids", async () => {
    const served = fakeFetch({});
    const source = new PemKidKeySource({
      urlTemplate: "https://keys.example.test/{kid}",
      fetch: served.fetch,
      now: () => NOW,
    });
    await rejects(
      verifyJwt(
        await mint(ec, base(), { header: { kid: "../x" } }),
        source,
        rules(),
      ),
      /invalid kid/,
    );
    await rejects(
      verifyJwt(
        await mint(ec, base(), { header: { kid: "a" } }),
        source,
        rules(),
      ),
    );
    await rejects(
      verifyJwt(
        await mint(ec, base(), { header: { kid: "b" } }),
        source,
        rules(),
      ),
      /rate limited/,
    );
    expect(served.calls).toHaveLength(1);
  });
});
