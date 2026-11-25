import { describe, expect, it } from "vitest";
import { resolveOperatorAwsEnvironment } from "./aws-credentials.js";

const profile = async () => ({
  accessKeyId: "ASIAPROFILE",
  secretAccessKey: "profile-secret",
  sessionToken: "profile-token",
});
const noRegion = async () => undefined;

describe("operator AWS resolution", () => {
  it("resolves credentials and region from the profile when env has none", async () => {
    const env = await resolveOperatorAwsEnvironment(
      { AWS_PROFILE: "sso" },
      { credentials: profile, profileRegion: async () => "ap-northeast-1" },
    );
    expect(env).toMatchObject({
      AWS_ACCESS_KEY_ID: "ASIAPROFILE",
      AWS_SECRET_ACCESS_KEY: "profile-secret",
      AWS_SESSION_TOKEN: "profile-token",
      AWS_REGION: "ap-northeast-1",
    });
  });
  it("keeps explicit env credentials and region without asking the provider", async () => {
    const env = await resolveOperatorAwsEnvironment(
      {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "AKIDENV",
        AWS_SECRET_ACCESS_KEY: "env-secret",
      },
      {
        credentials: async () => {
          throw new Error("must not be called");
        },
        profileRegion: async () => "eu-west-1",
      },
    );
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIDENV");
    expect(env.AWS_REGION).toBe("us-east-1");
  });
  it("sanitizes provider failures and can leave the environment unchanged", async () => {
    const failing = async () => {
      throw new Error("profile prod-admin token expired /home/x/.aws/sso");
    };
    const error = await resolveOperatorAwsEnvironment(
      { AWS_PROFILE: "prod-admin" },
      { credentials: failing, profileRegion: noRegion, required: true },
    ).catch((value: unknown) => value);
    expect(String(error)).toMatch(/Unable to resolve AWS credentials/);
    expect(String(error)).not.toMatch(/prod-admin|\.aws/);
    const env = await resolveOperatorAwsEnvironment(
      { AWS_PROFILE: "prod-admin" },
      { credentials: failing, profileRegion: noRegion },
    );
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });
});
