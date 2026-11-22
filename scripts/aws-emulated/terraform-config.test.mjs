import { describe, expect, it } from "vitest";
import { providerOverride, terraformEnvironment } from "./terraform-config.mjs";

describe("Terraform emulator routing", () => {
  it("pins every configured endpoint to loopback and rejects remote origins", () => {
    const config = providerOverride("http://127.0.0.1:12345", "6.32.1");
    expect(Object.values(config.provider.aws[0].endpoints)).toEqual(
      Array(10).fill("http://127.0.0.1:12345"),
    );
    expect(config.provider.aws[0].s3_use_path_style).toBe(true);
    expect(() => providerOverride("https://example.com", "6.32.1")).toThrow();
    expect(() =>
      providerOverride("http://127.0.0.1:12345", "6.50.0"),
    ).toThrow();
  });
  it("drops inherited AWS and Terraform configuration and blocks other HTTP endpoints", () => {
    const env = terraformEnvironment(
      {
        AWS_PROFILE: "user-profile",
        AWS_SESSION_TOKEN: "token",
        TF_PLUGIN_CACHE_DIR: "shared",
        TF_CLI_ARGS: "unsafe",
        PATH: "test-path",
      },
      "http://127.0.0.1:12345",
    );
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_SESSION_TOKEN).toBeUndefined();
    expect(env.TF_PLUGIN_CACHE_DIR).toBeUndefined();
    expect(env.TF_CLI_ARGS).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL).toBe("http://127.0.0.1:12345");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:9");
    expect(env.PATH).toBe("test-path");
  });
});
