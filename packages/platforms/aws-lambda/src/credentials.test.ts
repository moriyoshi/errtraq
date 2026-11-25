import { describe, expect, it } from "vitest";
import { lambdaAwsCredentials } from "./credentials.js";

describe("lambdaAwsCredentials", () => {
  it("reads the execution role credentials on every call", () => {
    const environment: Record<string, string | undefined> = {
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
    };
    const provider = lambdaAwsCredentials(environment);
    expect(provider()).toEqual({
      accessKeyId: "id",
      secretAccessKey: "secret",
      sessionToken: "token",
    });
    environment.AWS_ACCESS_KEY_ID = "next";
    expect(provider().accessKeyId).toBe("next");
  });
  it("passes a valid expiration to the engine and ignores an invalid one", () => {
    const base = { AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" };
    expect(
      lambdaAwsCredentials({
        ...base,
        AWS_CREDENTIAL_EXPIRATION: "2026-11-25T12:00:00Z",
      })().expiration,
    ).toEqual(new Date("2026-11-25T12:00:00Z"));
    expect(
      lambdaAwsCredentials({ ...base, AWS_CREDENTIAL_EXPIRATION: "soon" })(),
    ).not.toHaveProperty("expiration");
  });
  it("fails clearly when the role credentials are missing", () => {
    expect(() => lambdaAwsCredentials({})()).toThrow("credentials are missing");
  });
});
