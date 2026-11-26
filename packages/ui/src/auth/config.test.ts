import { describe, expect, it } from "vitest";
import { readAuthMode, readOidcConfig } from "./config";

describe("sign-in build configuration", () => {
  it("has no SSO without an issuer", () => {
    expect(readOidcConfig({})).toBeNull();
    expect(readOidcConfig({ VITE_ERRTRAQ_OIDC_ISSUER: " " })).toBeNull();
  });
  it("applies the defaults and validates the rest", () => {
    expect(
      readOidcConfig({
        VITE_ERRTRAQ_OIDC_ISSUER: "https://idp.test",
        VITE_ERRTRAQ_OIDC_CLIENT_ID: "spa",
      }),
    ).toEqual({
      issuer: "https://idp.test",
      clientId: "spa",
      scopes: "openid email profile",
      tokenKind: "access",
    });
    expect(() =>
      readOidcConfig({ VITE_ERRTRAQ_OIDC_ISSUER: "https://idp.test" }),
    ).toThrow(/CLIENT_ID/);
    expect(() =>
      readOidcConfig({
        VITE_ERRTRAQ_OIDC_ISSUER: "https://idp.test",
        VITE_ERRTRAQ_OIDC_CLIENT_ID: "spa",
        VITE_ERRTRAQ_OIDC_TOKEN: "refresh",
      }),
    ).toThrow(/access or id/);
  });
  it("selects proxy mode explicitly", () => {
    expect(readAuthMode({})).toBe("token");
    expect(readAuthMode({ VITE_ERRTRAQ_AUTH: "proxy" })).toBe("proxy");
    expect(() => readAuthMode({ VITE_ERRTRAQ_AUTH: "magic" })).toThrow();
  });
});
