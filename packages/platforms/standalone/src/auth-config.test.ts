import { env, variable } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { configSchema, manifest } from "./stack.js";

const grant = {
  claim: "groups",
  value: "viewers",
  org: "default",
  scopes: ["event:read"],
};
const stackSchema = manifest.configSchema as {
  safeParse: (v: unknown) => { success: boolean; error?: { message: string } };
};
const unsigned = {
  kind: "unsigned",
  trustUnsignedHeaders: true,
  preset: "oauth2-proxy",
  secretHeader: "x-errtraq-proxy-secret",
  grants: [grant],
};

describe("standalone sign-in settings", () => {
  it("accepts OIDC with a variable issuer and a signed proxy preset", () => {
    const result = stackSchema.safeParse({
      oidc: {
        issuer: variable("OIDC_ISSUER"),
        audience: env("OIDC_AUDIENCE"),
        grants: [grant],
      },
      proxyAuth: {
        kind: "signed",
        preset: "cloudflare-access",
        team: "acme",
        audience: "tag",
        grants: [grant],
      },
    });
    expect(result.success).toBe(true);
  });
  it("accepts unsigned headers with the secret as a reference, and rejects a literal", () => {
    expect(
      stackSchema.safeParse({
        proxyAuth: { ...unsigned, secret: env("PROXY_SECRET") },
      }).success,
    ).toBe(true);
    const literal = stackSchema.safeParse({
      proxyAuth: { ...unsigned, secret: "literal-secret-value-123" },
    });
    expect(literal.success).toBe(false);
    expect(literal.error?.message).toMatch(/config reference/);
  });
  it("requires trustUnsignedHeaders and a secret header", () => {
    const secret = env("PROXY_SECRET");
    for (const proxyAuth of [
      { ...unsigned, secret, trustUnsignedHeaders: false },
      { ...unsigned, secret, secretHeader: undefined },
      { ...unsigned, secret: undefined },
    ])
      expect(stackSchema.safeParse({ proxyAuth }).success).toBe(false);
  });
  it("rejects wildcards, plain HTTP issuers, foreign scopes and empty grants", () => {
    const ok = { issuer: "https://idp.example.test", audience: "a" };
    for (const oidc of [
      { ...ok, grants: [{ ...grant, value: "*" }] },
      { ...ok, grants: [{ ...grant, scopes: ["org:read"] }] },
      { ...ok, grants: [] },
      { ...ok, issuer: "http://idp.example.test", grants: [grant] },
      {
        ...ok,
        jwksUri: "https://x.test",
        jwks: { keys: [{}] },
        grants: [grant],
      },
    ])
      expect(stackSchema.safeParse({ oidc }).success).toBe(false);
    // Plain HTTP is for loopback development only.
    expect(
      stackSchema.safeParse({
        oidc: { ...ok, issuer: "http://127.0.0.1:9000", grants: [grant] },
      }).success,
    ).toBe(true);
  });
  it("validates resolved settings at runtime", () => {
    expect(
      configSchema.safeParse({
        oidc: {
          issuer: "https://idp.example.test",
          audience: "a",
          grants: [grant],
        },
        proxyAuth: { ...unsigned, secret: "resolved-secret-value-123" },
      }).success,
    ).toBe(true);
    expect(
      configSchema.safeParse({ proxyAuth: { ...unsigned, secret: "short" } })
        .success,
    ).toBe(false);
  });
});
