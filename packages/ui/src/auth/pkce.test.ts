import { describe, expect, it } from "vitest";
import { challengeOf, createVerifier, randomString } from "./pkce";

describe("PKCE", () => {
  it("matches the RFC 7636 appendix B vector", async () => {
    expect(
      await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("creates verifiers of 43 to 128 unreserved characters", () => {
    for (let i = 0; i < 50; i++) {
      const verifier = createVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    }
    expect(createVerifier()).not.toBe(createVerifier());
  });
  it("produces base64url without padding", () => {
    expect(randomString(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
