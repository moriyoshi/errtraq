import { GcpTokenVerificationError } from "@moriyoshi/errtraq-gcp-auth";
import { describe, expect, it, vi } from "vitest";
import {
  bearerToken,
  createGcpRuntimeAuth,
  createOidcVerifier,
  gcpHostBindings,
  SQL_LOGIN_SCOPE,
} from "./auth.js";

describe("bearerToken", () => {
  it("reads Headers and plain records, case-insensitively", () => {
    expect(bearerToken(new Headers({ Authorization: "Bearer a.b.c" }))).toBe(
      "a.b.c",
    );
    expect(bearerToken({ Authorization: "bearer a.b.c" })).toBe("a.b.c");
    expect(bearerToken({ authorization: "Basic xyz" })).toBeUndefined();
    expect(bearerToken({})).toBeUndefined();
  });
});
describe("OIDC verifier", () => {
  const headers = { authorization: "Bearer tok.en.sig" };
  it("passes audience and invoker email to the Google verifier", async () => {
    const verify = vi.fn(async () => ({}) as never);
    const ok = createOidcVerifier({
      audience: "aud",
      email: "push@p.iam.gserviceaccount.com",
      requireEmail: true,
      verify,
    });
    expect(await ok(headers)).toBe(true);
    expect(verify).toHaveBeenCalledWith("tok.en.sig", {
      audience: "aud",
      email: "push@p.iam.gserviceaccount.com",
    });
  });
  it("rejects a token that fails verification without logging it", async () => {
    const warn = vi.fn();
    const verify = vi.fn(async () => {
      throw new GcpTokenVerificationError("Unexpected ID token audience");
    });
    const result = await createOidcVerifier({
      audience: "aud",
      verify,
      logger: { warn },
    })(headers);
    expect(result).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("tok.en.sig");
  });
  it("fails closed on a missing token or binding", async () => {
    const verify = vi.fn();
    const call = (options: object, h: Record<string, string> = headers) =>
      createOidcVerifier({ audience: "aud", verify, ...options })(h);
    expect(await call({}, {})).toBe(false);
    expect(await call({ audience: undefined })).toBe(false);
    expect(await call({ requireEmail: true })).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it("propagates non-verification failures (a network fault is a retry, not a 401)", async () => {
    const verify = vi.fn(async () => {
      throw new Error("jwks unreachable");
    });
    await expect(
      createOidcVerifier({ audience: "aud", verify })(headers),
    ).rejects.toThrow("jwks unreachable");
  });
});
describe("metadata-backed runtime auth", () => {
  const fetchFake = () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/email"))
        return new Response("fn@p.iam.gserviceaccount.com");
      return Response.json({ access_token: "ya29.x", expires_in: 3600 });
    }) as unknown as typeof fetch;
    return { urls, fetcher };
  };
  it("asks for cloud-platform by default and the Cloud SQL login scope for SQL", async () => {
    const { urls, fetcher } = fetchFake();
    const auth = createGcpRuntimeAuth(
      { GCE_METADATA_HOST: "metadata.test" },
      fetcher,
    );
    expect(await auth.accessToken()).toBe("ya29.x");
    expect(await auth.sqlAccessToken()).toBe("ya29.x");
    expect(await auth.serviceAccountEmail()).toBe(
      "fn@p.iam.gserviceaccount.com",
    );
    expect(urls.every((url) => url.startsWith("http://metadata.test/"))).toBe(
      true,
    );
    expect(
      urls.some((url) => url.includes(encodeURIComponent(SQL_LOGIN_SCOPE))),
    ).toBe(true);
  });
  it("wires token sources into exactly the adapters that declare them", async () => {
    const { fetcher } = fetchFake();
    const auth = createGcpRuntimeAuth({}, fetcher);
    const verifyPush = vi.fn(async () => true);
    const bindings = gcpHostBindings(auth, verifyPush);
    const at = (id: string) =>
      bindings({ path: id, id, kind: "store" }) as Record<string, unknown>;
    expect(Object.keys(at("store-firestore"))).toEqual(["accessToken"]);
    expect(Object.keys(at("kv-firestore"))).toEqual(["accessToken"]);
    expect(Object.keys(at("queue-pubsub")).sort()).toEqual([
      "accessToken",
      "verifyPush",
    ]);
    expect(Object.keys(at("postgres")).sort()).toEqual([
      "accessToken",
      "serviceAccountEmail",
    ]);
    expect(at("blob-gcs")).toEqual({});
    expect(await (at("postgres").accessToken as () => Promise<string>)()).toBe(
      "ya29.x",
    );
  });
});
