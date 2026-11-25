import { describe, expect, it } from "vitest";
import * as publicApi from "./index.js";
import { create, infra, manifest } from "./index.js";
import { ArchiveEngineNotWiredError } from "./runtime.js";

describe("archive-iceberg manifest", () => {
  it("is an archive adapter with catalog and engine children", () => {
    expect(manifest.kind).toBe("archive");
    expect(manifest.childKinds).toEqual({
      catalog: "catalog",
      engine: "engine",
    });
    expect(manifest.capabilities).toEqual({ rowDelete: "position-delete" });
    expect(Object.keys(publicApi).sort()).toEqual([
      "create",
      "infra",
      "manifest",
    ]);
  });

  it("validates catalog settings and rejects unknown fields", () => {
    const schema = manifest.configSchema;
    const ok = schema.parse({
      catalog: { uri: "http://localhost:8181/catalog", warehouse: "errtraq" },
    }) as { catalog: { auth: unknown }; namespace: string };
    expect(ok.catalog.auth).toEqual({ type: "none" });
    expect(ok.namespace).toBe("errtraq");
    expect(
      schema.safeParse({
        catalog: {
          uri: "https://s3tables.us-east-1.amazonaws.com/iceberg",
          warehouse: "arn:aws:s3tables:us-east-1:000000000000:bucket/errtraq",
          auth: { type: "sigv4", region: "us-east-1" },
        },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        catalog: {
          uri: "http://x.test",
          auth: { type: "oauth2", clientId: "c", clientSecretSecret: "s" },
        },
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ catalog: { uri: "not a url" } }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        catalog: { uri: "http://x.test", auth: { type: "bearer" } },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        catalog: {
          uri: "http://x.test",
          auth: { type: "bearer", token: "plain" },
        },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ catalog: { uri: "http://x.test" }, extra: 1 }).success,
    ).toBe(false);
  });

  it("describes no provisioned resources yet", () => {
    expect(infra.module.provider).toBe("local");
    expect(
      infra.inputs({ catalog: { uri: "http://x.test" } }, {} as never),
    ).toEqual({});
  });
});

describe("create", () => {
  const config = { catalog: { uri: "http://localhost:8181/catalog" } };
  it("returns an ArchiveStore whose operations report the engine is not wired", async () => {
    const store = create({ config, bindings: {}, dependencies: {} });
    expect(store.capabilities.rowDelete).toBe("position-delete");
    await expect(
      store.hasBatch("b", ["2026-01-01", "2026-01-01"] as never),
    ).rejects.toBeInstanceOf(ArchiveEngineNotWiredError);
    await expect(
      store.expireSnapshots("2026-01-01T00:00:00.000Z" as never),
    ).rejects.toThrow(/TODO\(M4f\)/);
  });
  it("requires a secret source for secret-backed auth and credentials for sigv4", () => {
    const bearer = {
      catalog: {
        uri: "http://x.test",
        auth: { type: "bearer" as const, tokenSecret: "t" },
      },
    };
    expect(() =>
      create({ config: bearer, bindings: {}, dependencies: {} }),
    ).not.toThrow();
    const sigv4 = {
      catalog: {
        uri: "http://x.test",
        auth: { type: "sigv4" as const, region: "us-east-1" },
      },
    };
    expect(() =>
      create({ config: sigv4, bindings: {}, dependencies: {} }),
    ).toThrow(/credentials/);
    expect(() =>
      create({
        config: sigv4,
        bindings: {
          awsCredentials: () => ({ accessKeyId: "a", secretAccessKey: "b" }),
        },
        dependencies: {},
      }),
    ).not.toThrow();
  });
});
