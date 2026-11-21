import { describe, expect, it } from "vitest";
import { create } from "./postgres.js";
import { rdsIamPoolConfig } from "./postgres-dialect.js";

describe("RDS IAM connections", () => {
  it("verifies TLS and signs each new connection with current credentials and time", async () => {
    const environment: Record<string, string> = {
      AWS_ACCESS_KEY_ID: "FIRSTKEY",
      AWS_SECRET_ACCESS_KEY: "firstsecret",
      AWS_SESSION_TOKEN: "firsttoken",
    };
    let now = new Date("2024-01-02T03:04:05Z");
    const config = rdsIamPoolConfig({
      host: "db.example.rds.amazonaws.com",
      port: 5432,
      database: "db",
      user: "alice",
      region: "us-east-1",
      ca: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
      environment,
      now: () => now,
    });
    expect(config.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: "db.example.rds.amazonaws.com",
      ca: expect.stringContaining("BEGIN CERTIFICATE"),
    });
    if (typeof config.password !== "function")
      throw new Error("Expected password callback");
    const first = new URL(`https://${await config.password()}`);
    expect(first.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(first.searchParams.get("X-Amz-Date")).toBe("20240102T030405Z");
    expect(first.searchParams.get("X-Amz-Security-Token")).toBe("firsttoken");
    now = new Date("2024-01-02T03:20:06Z");
    Object.assign(environment, {
      AWS_ACCESS_KEY_ID: "SECONDKEY",
      AWS_SECRET_ACCESS_KEY: "secondsecret",
      AWS_SESSION_TOKEN: "secondtoken",
    });
    const next = new URL(`https://${await config.password()}`);
    expect(next.searchParams.get("X-Amz-Date")).toBe("20240102T032006Z");
    expect(next.searchParams.get("X-Amz-Credential")).toContain("SECONDKEY/");
    expect(next.searchParams.get("X-Amz-Security-Token")).toBe("secondtoken");
    expect(next.searchParams.get("X-Amz-Signature")).not.toBe(
      first.searchParams.get("X-Amz-Signature"),
    );
  });
  it("fails clearly when the configured RDS CA file cannot be read", async () => {
    await expect(
      create({
        config: { mode: "iam" },
        bindings: {
          ERRTRAQ_POSTGRES_HOST: "db.example",
          ERRTRAQ_POSTGRES_PORT: "5432",
          ERRTRAQ_POSTGRES_DATABASE: "db",
          ERRTRAQ_POSTGRES_USER: "app",
          ERRTRAQ_POSTGRES_REGION: "us-east-1",
          ERRTRAQ_POSTGRES_CA_PATH: ".agents-workspace/tmp/missing-rds-ca.pem",
        },
        dependencies: {},
      }),
    ).rejects.toThrow("Cannot read RDS CA bundle");
  });
  it("rejects a missing CA instead of disabling verification", () => {
    expect(() =>
      rdsIamPoolConfig({
        host: "db.example",
        port: 5432,
        database: "db",
        user: "u",
        region: "us-east-1",
        ca: "",
        environment: {},
      }),
    ).toThrow("Invalid RDS CA bundle");
  });
});

it("keeps the original empty-config password construction working", async () => {
  const store = await create({
    config: {},
    bindings: { ERRTRAQ_POSTGRES_SECRET: "db-secret" },
    dependencies: {},
    secretSource: {
      read: async () => "postgresql://user:password@localhost/db",
    },
  });
  await store.close();
});
