import { describe, expect, it } from "vitest";
import { connectSources } from "./csp";

describe("connectSources", () => {
  it("is empty without configuration", () => {
    expect(connectSources({})).toEqual([]);
  });
  it("lists the API base, the issuer and extra origins once, as origins", () => {
    expect(
      connectSources({
        apiBase: "https://api.example.com/prefix",
        oidcIssuer: "https://idp.example.com/realms/x",
        oidcConnectSrc:
          "https://login.example.com, https://idp.example.com/other https://api.example.com",
      }),
    ).toEqual([
      "https://api.example.com",
      "https://idp.example.com",
      "https://login.example.com",
    ]);
  });
  it("rejects a value that is not a URL, naming the variable", () => {
    expect(() => connectSources({ oidcIssuer: "idp.example.com" })).toThrow(
      /VITE_ERRTRAQ_OIDC_ISSUER/,
    );
    expect(() => connectSources({ oidcConnectSrc: "nonsense" })).toThrow(
      /VITE_ERRTRAQ_OIDC_CONNECT_SRC/,
    );
  });
});
