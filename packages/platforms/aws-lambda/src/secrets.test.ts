import { describe, expect, it, vi } from "vitest";
import { createSecretsManagerSource, SecretReadError } from "./secrets.js";

const arn =
  "arn:aws:secretsmanager:us-west-2:123456789012:secret:database-ABC123";
const environment = {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "access",
  AWS_SECRET_ACCESS_KEY: "credential",
  AWS_SESSION_TOKEN: "token",
};
describe("Secrets Manager source", () => {
  it("retries Secrets Manager throttling using the shared request policy", async () => {
    let attempts = 0;
    const source = createSecretsManagerSource({
      environment,
      fetch: async () =>
        ++attempts === 1
          ? Response.json({ __type: "ThrottlingException" }, { status: 400 })
          : Response.json({ SecretString: "recovered" }),
    });
    expect(await source.read(arn)).toBe("recovered");
    expect(attempts).toBe(2);
  });
  it("signs for the ARN region, coalesces reads and refreshes after TTL", async () => {
    let now = 0;
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toContain("secretsmanager.us-west-2.amazonaws.com");
        expect(new Headers(init?.headers).get("x-amz-security-token")).toBe(
          "token",
        );
        expect(new Headers(init?.headers).get("x-amz-target")).toBe(
          "secretsmanager.GetSecretValue",
        );
        expect(JSON.parse(String(init?.body))).toEqual({ SecretId: arn });
        return Response.json({ SecretString: `value-${now}` });
      },
    );
    const source = createSecretsManagerSource({
      environment,
      ttlMs: 100,
      now: () => now,
      fetch: fetcher,
    });
    expect(await Promise.all([source.read(arn), source.read(arn)])).toEqual([
      "value-0",
      "value-0",
    ]);
    now = 99;
    expect(await source.read(arn)).toBe("value-0");
    now = 100;
    expect(await source.read(arn)).toBe("value-100");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("decodes UTF-8 binary secrets and rejects malformed values", async () => {
    const source = createSecretsManagerSource({
      environment,
      fetch: async () => Response.json({ SecretBinary: "aMOp" }),
    });
    expect(await source.read(arn)).toBe("hé");
    const bad = createSecretsManagerSource({
      environment,
      fetch: async () => Response.json({ SecretBinary: "////" }),
    });
    await expect(bad.read(arn)).rejects.toBeInstanceOf(SecretReadError);
  });
  it("returns typed errors without provider messages, identifiers, or secret values", async () => {
    const source = createSecretsManagerSource({
      environment,
      fetch: async () =>
        Response.json(
          { __type: "AccessDeniedException", message: "secret-value" },
          { status: 400 },
        ),
    });
    const error = await source.read(arn).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SecretReadError);
    expect(error).toMatchObject({
      providerCode: "AccessDeniedException",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("secret-value");
    expect(String(error)).not.toContain(arn);
    await expect(source.read("not-an-arn")).rejects.toMatchObject({
      providerCode: "InvalidIdentifier",
    });
    await expect(
      source.read(
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:database",
      ),
    ).rejects.toMatchObject({ providerCode: "InvalidIdentifier" });
  });
  it("reads secrets that RDS manages, whose names start with rds!", async () => {
    // RDS-managed master secrets are named `rds!db-<uuid>`; `!` is outside the character set
    // of user-created names, and rejecting it broke the deployed bootstrap (third AWS run).
    const source = createSecretsManagerSource({
      environment,
      fetch: async () => Response.json({ SecretString: "admin" }),
    });
    expect(
      await source.read(
        "arn:aws:secretsmanager:us-west-2:123456789012:secret:rds!db-0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b-AbC123",
      ),
    ).toBe("admin");
  });
});
