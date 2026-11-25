import { describe, expect, it } from "vitest";
import * as publicApi from "./index.js";
import { create, infra, manifest } from "./index.js";
import { ArchiveEngineNotWiredError } from "./runtime.js";
import { rowDeleteModeFor } from "./stack.js";

describe("archive-iceberg manifest", () => {
  it("is an archive adapter with catalog and engine children", () => {
    expect(manifest.kind).toBe("archive");
    expect(manifest.childKinds).toEqual({
      catalog: "catalog",
      engine: "engine",
    });
    expect(manifest.capabilities).toEqual({ rowDelete: "deletion-vector" });
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

  it("defaults the engine to format 3 and validates its options", () => {
    const schema = manifest.configSchema;
    const parsed = schema.parse({
      catalog: { uri: "http://x.test", warehouse: "w" },
    }) as {
      engine: Record<string, unknown> & { s3: Record<string, unknown> };
      catalog: { ignoreServerUri: boolean };
    };
    expect(parsed.engine).toMatchObject({
      catalogType: "lakekeeper",
      formatVersion: 3,
      homeDirectory: "/tmp/errtraq-duckdb",
      extensionMode: "runtime-install",
      retry: { maxAttempts: 8, baseDelayMs: 100, maxDelayMs: 5000 },
      s3: { urlStyle: "vhost", useSsl: true },
    });
    expect(parsed.catalog.ignoreServerUri).toBe(false);
    const bad = (engine: unknown) =>
      schema.safeParse({ catalog: { uri: "http://x.test" }, engine }).success;
    expect(bad({ formatVersion: 3, threads: 2, memoryLimit: "768MB" })).toBe(
      true,
    );
    expect(bad({ formatVersion: 1 })).toBe(false);
    expect(bad({ memoryLimit: "lots" })).toBe(false);
    expect(bad({ s3: { endpoint: "http://winterbaume:5555" } })).toBe(false);
    expect(bad({ s3: { accessKeyId: "plain" } })).toBe(false);
    expect(bad({ catalogType: "glue" })).toBe(false);
    expect(
      schema.safeParse({
        catalog: { uri: "http://x.test" },
        namespace: 'a"; drop',
      }).success,
    ).toBe(false);
  });

  it("derives the row delete mode from the format version", () => {
    expect(rowDeleteModeFor({ formatVersion: 3 })).toBe("deletion-vector");
    expect(rowDeleteModeFor({ formatVersion: 2 })).toBe("position-delete");
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
    expect(store.capabilities.rowDelete).toBe("deletion-vector");
    await expect(
      store.hasBatch("b", ["2026-01-01", "2026-01-01"] as never),
    ).rejects.toBeInstanceOf(ArchiveEngineNotWiredError);
    await expect(
      store.expireSnapshots("2026-01-01T00:00:00.000Z" as never),
    ).rejects.toThrow(/createEngine/);
  });
  it("delegates to a bound engine and keeps rowDelete truthful per format version", () => {
    const engine = { marker: true } as never;
    expect(
      create({
        config,
        bindings: { createEngine: () => engine },
        dependencies: {},
      }),
    ).toBe(engine);
    expect(
      create({
        config: { ...config, engine: { formatVersion: 2 } },
        bindings: {},
        dependencies: {},
      }).capabilities.rowDelete,
    ).toBe("position-delete");
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
