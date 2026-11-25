import { describe, expect, it, vi } from "vitest";
import { base64Decode, base64Encode } from "./encoding.js";
import { GcpAuthError, GcpTokenVerificationError } from "./errors.js";
import { IamSigner } from "./iam.js";
import { createCredentials } from "./index.js";
import { decodeJwt, RS256, signJwt } from "./jwt.js";
import { MetadataTokenSource } from "./metadata.js";
import { ServiceAccountTokenSource } from "./service-account.js";
import type { TokenSource } from "./token-source.js";
import { GoogleKeyStore, verifyGoogleIdToken } from "./verify.js";

export interface TestKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  pem: string;
  jwk: JsonWebKey;
}
export async function generateTestKey(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const lines = base64Encode(der).match(/.{1,64}/g) ?? [];
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    pem: `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`,
    jwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}
/** Mint an ID token the way Google does, signed by `key` under `kid`. */
export function mintIdToken(
  key: CryptoKey,
  claims: Record<string, unknown>,
  kid = "kid-1",
): Promise<string> {
  return signJwt(key, { kid }, claims);
}

const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

interface Harness {
  source: TokenSource;
  /** Requests that reached the token endpoint (access token or ID token). */
  calls: () => number;
  advance: (ms: number) => void;
  failNext: () => void;
  holdNext: () => () => void;
}
/** TokenSource contract: cache reuse, refresh before expiry, coalescing, failure, scope keying. */
function tokenSourceContract(name: string, make: () => Promise<Harness>) {
  describe(`TokenSource contract: ${name}`, () => {
    it("reuses a cached access token", async () => {
      const h = await make();
      const a = await h.source.getAccessToken();
      expect(await h.source.getAccessToken()).toBe(a);
      expect(h.calls()).toBe(1);
    });
    it("refreshes shortly before expiry", async () => {
      const h = await make();
      const a = await h.source.getAccessToken();
      h.advance(3600_000 - 61_000);
      expect(await h.source.getAccessToken()).toBe(a);
      h.advance(2_000);
      expect(await h.source.getAccessToken()).not.toBe(a);
      expect(h.calls()).toBe(2);
    });
    it("coalesces concurrent refreshes", async () => {
      const h = await make();
      const release = h.holdNext();
      const all = Promise.all(
        Array.from({ length: 5 }, () => h.source.getAccessToken()),
      );
      release();
      expect(new Set(await all).size).toBe(1);
      expect(h.calls()).toBe(1);
    });
    it("does not cache failures", async () => {
      const h = await make();
      h.failNext();
      await expect(h.source.getAccessToken()).rejects.toBeInstanceOf(
        GcpAuthError,
      );
      expect(await h.source.getAccessToken()).toBeTruthy();
    });
    it("keys the cache by scope set, ignoring order and duplicates", async () => {
      const h = await make();
      const a = await h.source.getAccessToken(["b", "a", "a"]);
      expect(await h.source.getAccessToken(["a", "b"])).toBe(a);
      expect(await h.source.getAccessToken(["c"])).not.toBe(a);
      expect(h.calls()).toBe(2);
    });
    it("caches ID tokens per audience", async () => {
      const h = await make();
      const a = await h.source.getIdToken("https://one");
      expect(await h.source.getIdToken("https://one")).toBe(a);
      expect(await h.source.getIdToken("https://two")).not.toBe(a);
    });
  });
}

const ID_EXP = 3600;
function idTokenFor(signer: CryptoKey, audience: string, now: number) {
  return mintIdToken(signer, {
    iss: "https://accounts.google.com",
    aud: audience,
    sub: "1",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + ID_EXP,
  });
}

async function metadataHarness(): Promise<Harness> {
  const signing = await generateTestKey();
  let now = 1_700_000_000_000;
  let count = 0;
  let fail = false;
  let hold: Promise<void> | undefined;
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("metadata-flavor")).toBe("Google");
      if (hold) await hold;
      if (fail) {
        fail = false;
        return new Response("nope", { status: 503 });
      }
      if (url.pathname.endsWith("/token")) {
        count++;
        return json({
          access_token: `at-${url.searchParams.get("scopes") ?? "default"}-${count}`,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (url.pathname.endsWith("/identity")) {
        count++;
        return new Response(
          await idTokenFor(
            signing.privateKey,
            url.searchParams.get("audience") ?? "",
            now,
          ),
        );
      }
      if (url.pathname.endsWith("/email"))
        return new Response("sa@example.test\n");
      return new Response("?", { status: 404 });
    },
  );
  return {
    source: new MetadataTokenSource({
      fetch: fetcher as typeof fetch,
      clock: () => now,
      host: "metadata.test",
    }),
    calls: () => count,
    advance: (ms) => {
      now += ms;
    },
    failNext: () => {
      fail = true;
    },
    holdNext: () => {
      const g = gate();
      hold = g.promise;
      return () => g.release();
    },
  };
}
async function serviceAccountHarness(): Promise<Harness> {
  const keys = await generateTestKey();
  const idKey = await generateTestKey();
  let now = 1_700_000_000_000;
  let count = 0;
  let fail = false;
  let hold: Promise<void> | undefined;
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (hold) await hold;
    if (fail) {
      fail = false;
      return json({ error: "backend_error" }, { status: 500 });
    }
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const { claims } = decodeJwt(form.get("assertion") ?? "");
    count++;
    if (claims.target_audience)
      return json({
        id_token: await idTokenFor(
          idKey.privateKey,
          String(claims.target_audience),
          now,
        ),
      });
    return json({
      access_token: `at-${claims.scope}-${count}`,
      expires_in: 3600,
    });
  };
  return {
    source: new ServiceAccountTokenSource({
      key: JSON.stringify({
        type: "service_account",
        client_email: "sa@example.test",
        private_key: keys.pem,
        private_key_id: "key-1",
      }),
      fetch: fetcher as typeof fetch,
      clock: () => now,
    }),
    calls: () => count,
    advance: (ms) => {
      now += ms;
    },
    failNext: () => {
      fail = true;
    },
    holdNext: () => {
      const g = gate();
      hold = g.promise;
      return () => g.release();
    },
  };
}
tokenSourceContract("metadata server", metadataHarness);
tokenSourceContract("service account key", serviceAccountHarness);

describe("metadata server", () => {
  it("requests the scopes and email from the default service account", async () => {
    const requests: string[] = [];
    const source = new MetadataTokenSource({
      host: "169.254.169.254",
      fetch: (async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return String(input).endsWith("/email")
          ? new Response("sa@example.test")
          : json({ access_token: "t", expires_in: 100 });
      }) as typeof fetch,
    });
    await source.getAccessToken(["s2", "s1"]);
    expect(await source.serviceAccountEmail()).toBe("sa@example.test");
    expect(requests[0]).toBe(
      "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token?scopes=s1%2Cs2",
    );
  });
  it("rejects malformed token responses and a bad host", async () => {
    const source = new MetadataTokenSource({
      fetch: (async () => json({ access_token: "" })) as typeof fetch,
    });
    await expect(source.getAccessToken()).rejects.toMatchObject({
      code: "bad_response",
    });
    expect(() => new MetadataTokenSource({ host: "a/b" })).toThrow();
  });
  it("reports an unreachable server without leaking details", async () => {
    const source = new MetadataTokenSource({
      fetch: (async () => {
        throw new Error("secret detail");
      }) as typeof fetch,
    });
    const error = await source.getAccessToken().catch((e) => e);
    expect(error).toMatchObject({ code: "unavailable" });
    expect(error.message).not.toContain("secret");
  });
});

describe("service account JWT bearer grant", () => {
  it("signs a verifiable RS256 assertion with the documented claim set", async () => {
    const keys = await generateTestKey();
    let assertion = "";
    const source = new ServiceAccountTokenSource({
      key: {
        client_email: "sa@example.test",
        private_key: keys.pem,
        private_key_id: "key-1",
      },
      clock: () => 1_700_000_000_000,
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        assertion =
          new URLSearchParams(String(init?.body)).get("assertion") ?? "";
        return json({ access_token: "x", expires_in: 60 });
      }) as typeof fetch,
    });
    await source.getAccessToken(["https://scope/a"]);
    const jwt = decodeJwt(assertion);
    expect(jwt.header).toEqual({ kid: "key-1", alg: "RS256", typ: "JWT" });
    expect(jwt.claims).toEqual({
      iss: "sa@example.test",
      scope: "https://scope/a",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(
      await crypto.subtle.verify(
        RS256,
        keys.publicKey,
        jwt.signature,
        jwt.signingInput,
      ),
    ).toBe(true);
  });
  it("signs arbitrary payloads locally as a BlobSigner", async () => {
    const keys = await generateTestKey();
    const source = new ServiceAccountTokenSource({
      key: { client_email: "sa@example.test", private_key: keys.pem },
    });
    const payload = new TextEncoder().encode("string to sign");
    const signature = (await source.sign(payload)) as Uint8Array<ArrayBuffer>;
    expect(
      await crypto.subtle.verify(RS256, keys.publicKey, signature, payload),
    ).toBe(true);
  });
  it("rejects malformed keys without echoing the key", async () => {
    const attempt = (key: string) =>
      new ServiceAccountTokenSource({
        key,
        fetch: (async () => json({})) as typeof fetch,
      });
    expect(() => attempt("not json SECRET")).toThrow(/not valid JSON/);
    expect(() => attempt('{"client_email":"a"}')).toThrow(GcpAuthError);
    const bad = attempt(
      JSON.stringify({
        client_email: "a@b",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
      }),
    );
    const error = await bad.getAccessToken().catch((e) => e);
    expect(error).toMatchObject({ code: "bad_key" });
    expect(error.message).not.toContain("AAAA");
  });
  it("requires an https token URI", () => {
    expect(
      () =>
        new ServiceAccountTokenSource({
          key: {
            client_email: "a@b",
            private_key: "x",
            token_uri: "http://evil.test/token",
          },
        }),
    ).toThrow(/https/);
  });
  it("surfaces OAuth errors by code only", async () => {
    const keys = await generateTestKey();
    const source = new ServiceAccountTokenSource({
      key: { client_email: "a@b", private_key: keys.pem },
      fetch: (async () =>
        json(
          { error: "invalid_grant", error_description: "secret" },
          { status: 400 },
        )) as typeof fetch,
    });
    const error = await source.getAccessToken().catch((e) => e);
    expect(error).toMatchObject({ code: "denied", status: 400 });
    expect(error.message).toContain("invalid_grant");
    expect(error.message).not.toContain("secret");
  });
});

describe("IAM signBlob", () => {
  it("posts the base64 payload and returns the decoded signature", async () => {
    const seen: { url: string; body: unknown; auth: string | null }[] = [];
    const signer = new IamSigner({
      tokenSource: {
        getAccessToken: async () => "tok",
        getIdToken: async () => "",
      },
      email: async () => "sa@example.test",
      endpoint: "https://iam.example.test/",
      fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return json({
          keyId: "k",
          signedBlob: base64Encode(new Uint8Array([9, 8, 7])),
        });
      }) as typeof fetch,
    });
    expect(await signer.sign(new Uint8Array([1, 2, 3]))).toEqual(
      new Uint8Array([9, 8, 7]),
    );
    expect(seen).toEqual([
      {
        url: "https://iam.example.test/v1/projects/-/serviceAccounts/sa%40example.test:signBlob",
        body: { payload: base64Encode(new Uint8Array([1, 2, 3])) },
        auth: "Bearer tok",
      },
    ]);
  });
  it.each([
    [403, "denied"],
    [503, "unavailable"],
    [400, "failed"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const signer = new IamSigner({
      tokenSource: {
        getAccessToken: async () => "tok",
        getIdToken: async () => "",
      },
      email: "sa@example.test",
      fetch: (async () => json({}, { status })) as typeof fetch,
    });
    await expect(signer.sign(new Uint8Array())).rejects.toMatchObject({ code });
  });
  it("is wired by createCredentials for the metadata mode", async () => {
    const calls: string[] = [];
    const { signer } = createCredentials(
      { mode: "metadata", host: "md.test" },
      {
        fetch: (async (url: RequestInfo | URL) => {
          calls.push(String(url));
          const text = String(url);
          if (text.endsWith("/email")) return new Response("sa@example.test");
          if (text.includes("/token"))
            return json({ access_token: "t", expires_in: 600 });
          return json({ signedBlob: base64Encode(new Uint8Array([1])) });
        }) as typeof fetch,
      },
    );
    await signer?.sign(new Uint8Array());
    expect(calls.at(-1)).toContain(
      "serviceAccounts/sa%40example.test:signBlob",
    );
  });
});

describe("Google ID token verification", () => {
  const NOW = 1_700_000_000_000;
  const base = (over: Record<string, unknown> = {}) => ({
    iss: "https://accounts.google.com",
    aud: "https://consumer.example.test/_errtraq/push",
    sub: "123",
    email: "pusher@example.test",
    email_verified: true,
    iat: NOW / 1000,
    exp: NOW / 1000 + 3600,
    ...over,
  });
  async function setup() {
    const signing = await generateTestKey();
    let fetches = 0;
    let now = NOW;
    const jwks = {
      keys: [{ ...signing.jwk, kid: "kid-1", use: "sig", alg: "RS256" }],
    };
    const store = new GoogleKeyStore({
      clock: () => now,
      fetch: (async () => {
        fetches++;
        return json(jwks, {
          headers: { "cache-control": "public, max-age=100" },
        });
      }) as typeof fetch,
    });
    const verify = (token: string, over = {}) =>
      verifyGoogleIdToken(token, {
        audience: "https://consumer.example.test/_errtraq/push",
        keys: store,
        clock: () => now,
        ...over,
      });
    return {
      signing,
      verify,
      fetches: () => fetches,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  it("accepts a valid token and returns its claims", async () => {
    const t = await setup();
    const claims = await t.verify(
      await mintIdToken(t.signing.privateKey, base()),
      {
        email: "pusher@example.test",
      },
    );
    expect(claims.sub).toBe("123");
  });
  it.each([
    ["wrong issuer", { iss: "https://evil.test" }, {}],
    ["wrong audience", { aud: "https://other" }, {}],
    ["expired", { exp: NOW / 1000 - 120 }, {}],
    ["not yet valid", { nbf: NOW / 1000 + 600 }, {}],
    ["missing subject", { sub: undefined }, {}],
    [
      "wrong email",
      { email: "other@example.test" },
      { email: "pusher@example.test" },
    ],
    [
      "unverified email",
      { email_verified: false },
      { email: "pusher@example.test" },
    ],
  ])("rejects %s", async (_name, claims, options) => {
    const t = await setup();
    await expect(
      t.verify(await mintIdToken(t.signing.privateKey, base(claims)), options),
    ).rejects.toBeInstanceOf(GcpTokenVerificationError);
  });
  it("accepts accounts.google.com without the scheme and array audiences", async () => {
    const t = await setup();
    await t.verify(
      await mintIdToken(
        t.signing.privateKey,
        base({ iss: "accounts.google.com", aud: ["x", base().aud] }),
      ),
    );
  });
  it("rejects tampered signatures, foreign keys, unknown kids and garbage", async () => {
    const t = await setup();
    const good = await mintIdToken(t.signing.privateKey, base());
    const [h, p, s] = good.split(".") as [string, string, string];
    const forged = `${h}.${p.slice(0, -2)}AA.${s}`;
    await expect(t.verify(forged)).rejects.toBeInstanceOf(
      GcpTokenVerificationError,
    );
    const stranger = await generateTestKey();
    await expect(
      t.verify(await mintIdToken(stranger.privateKey, base())),
    ).rejects.toBeInstanceOf(GcpTokenVerificationError);
    await expect(
      t.verify(await mintIdToken(t.signing.privateKey, base(), "nope")),
    ).rejects.toThrow(/Unknown signing key/);
    await expect(t.verify("a.b")).rejects.toThrow(/Malformed/);
    await expect(t.verify("")).rejects.toThrow(/Malformed/);
  });
  it("rejects alg none and HS256 headers", async () => {
    const t = await setup();
    const enc = (v: unknown) => btoa(JSON.stringify(v)).replaceAll("=", "");
    for (const alg of ["none", "HS256"])
      await expect(
        t.verify(`${enc({ alg, kid: "kid-1" })}.${enc(base())}.AAAA`),
      ).rejects.toThrow(/algorithm/);
  });
  it("caches the JWKS per max-age and throttles refetch for unknown kids", async () => {
    const t = await setup();
    const token = await mintIdToken(t.signing.privateKey, base());
    await t.verify(token);
    await t.verify(token);
    expect(t.fetches()).toBe(1);
    await expect(
      t.verify(await mintIdToken(t.signing.privateKey, base(), "rotated")),
    ).rejects.toThrow();
    expect(t.fetches()).toBe(1);
    t.advance(61_000);
    await expect(
      t.verify(
        await mintIdToken(
          t.signing.privateKey,
          base({ exp: NOW / 1000 + 7200 }),
          "rotated",
        ),
      ),
    ).rejects.toThrow();
    expect(t.fetches()).toBe(2);
    t.advance(101_000);
    await t.verify(
      await mintIdToken(t.signing.privateKey, base({ exp: NOW / 1000 + 7200 })),
    );
    expect(t.fetches()).toBe(3);
  });
  it("fails closed when the JWKS endpoint is down", async () => {
    const signing = await generateTestKey();
    const store = new GoogleKeyStore({
      fetch: (async () => new Response("", { status: 500 })) as typeof fetch,
    });
    await expect(
      verifyGoogleIdToken(await mintIdToken(signing.privateKey, base()), {
        audience: base().aud,
        keys: store,
        clock: () => NOW,
      }),
    ).rejects.toBeInstanceOf(GcpTokenVerificationError);
  });
});

describe("encoding", () => {
  it("round-trips base64url with padding variants", () => {
    for (const length of [0, 1, 2, 3, 4, 31]) {
      const bytes = Uint8Array.from({ length }, (_, i) => 250 - i);
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    }
  });
});
