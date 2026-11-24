import { type BootstrapVault, hashApiToken } from "@moriyoshi/errtraq-core";
import { MemoryActiveStore, MemoryKV } from "@moriyoshi/errtraq-testing";
import { describe, expect, it, vi } from "vitest";
import {
  bootstrapSecretName,
  createBootstrapHandler,
} from "./bootstrap-handler.js";

const arn =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:errtraq/bootstrap-ABC123";
const request = {
  version: 1,
  orgSlug: "org",
  projectSlug: "project",
  ingestUrl: "https://ingest.example/",
};
function fixture(extra: Record<string, unknown> = {}) {
  const store = new MemoryActiveStore();
  const kv = new MemoryKV();
  let value: string | undefined;
  const claims: string[] = [];
  const vault: BootstrapVault = {
    async claim(name, candidate) {
      claims.push(name);
      const created = value === undefined;
      value ??= candidate;
      return { identifier: arn, value, created };
    },
  };
  const logger = { info: vi.fn(), error: vi.fn() };
  const handler = createBootstrapHandler({
    stackName: "stack",
    store,
    kv,
    vault,
    secretName: "errtraq/bootstrap",
    logger,
    ...extra,
  });
  return { store, kv, handler, logger, claims, secret: () => value };
}
const everything = (...values: unknown[]) => JSON.stringify(values);

describe("bootstrap function handler", () => {
  it("migrates, bootstraps and returns a summary without the DSN or token", async () => {
    const f = fixture();
    const migrate = vi.spyOn(f.store, "migrate");
    const result = await f.handler(request);
    expect(migrate).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      version: 1,
      org: { slug: "org", created: true },
      project: { slug: "project", created: true, retentionDays: 30 },
      key: { created: true },
      token: { created: true },
      secret: { arn, created: true },
    });
    const saved = JSON.parse(f.secret() ?? "null") as {
      token: string;
      dsn: string;
    };
    expect(saved.dsn).toMatch(/^https:\/\/[a-f0-9]+@ingest\.example\/\d+$/);
    const publicKey = new URL(saved.dsn).username;
    const output = everything(
      result,
      f.logger.info.mock.calls,
      f.logger.error.mock.calls,
    );
    for (const secret of [saved.token, saved.dsn, publicKey])
      expect(output).not.toContain(secret);
    expect(f.claims).toEqual(["errtraq/bootstrap"]);
    expect(
      await f.store.projects.getTokenByHash(await hashApiToken(saved.token)),
    ).toMatchObject({ label: "bootstrap" });
  });
  it("is idempotent: a rerun reports everything as existing and keeps the secret", async () => {
    const f = fixture();
    await f.handler(request);
    const first = f.secret();
    const again = await f.handler(request);
    expect(again).toMatchObject({
      ok: true,
      org: { created: false },
      project: { created: false },
      key: { created: false },
      token: { created: false },
      secret: { created: false },
    });
    expect(f.secret()).toBe(first);
  });
  it("resumes after a failure between the secret and the token registration", async () => {
    const f = fixture();
    const original = f.store.projects.createToken.bind(f.store.projects);
    vi.spyOn(f.store.projects, "createToken")
      .mockRejectedValueOnce(new Error("connection to db.internal failed"))
      .mockImplementation(original);
    const failed = await f.handler(request);
    expect(failed).toMatchObject({
      ok: false,
      error: { code: "BootstrapFailed" },
    });
    // The provider message is neither returned nor logged.
    expect(everything(failed, f.logger.error.mock.calls)).not.toContain(
      "db.internal",
    );
    const resumed = await f.handler(request);
    expect(resumed).toMatchObject({ ok: true, token: { created: true } });
  });
  it("accepts only non-secret options and never echoes a rejected value", async () => {
    const f = fixture();
    const smuggled = `errtraq_${"a".repeat(64)}`;
    for (const bad of [
      { ...request, secretName: "other/secret" },
      { ...request, token: smuggled },
      { ...request, rateLimits: { issueEvents: 1, token: smuggled } },
      { ...request, version: 2 },
      { ...request, orgSlug: "has space" },
      { ...request, projectSlug: "" },
      { ...request, ingestUrl: 42 },
      { ...request, rateLimits: { issueEvents: 0 } },
      "text",
      null,
      [],
    ]) {
      const result = await f.handler(bad);
      expect(result).toMatchObject({
        ok: false,
        error: { code: "InvalidRequest" },
      });
      expect(JSON.stringify(result)).not.toContain(smuggled);
    }
    expect(f.claims).toEqual([]);
    expect(f.secret()).toBeUndefined();
  });
  it("rejects a non-HTTPS ingest origin before touching the store", async () => {
    const f = fixture();
    const migrate = vi.spyOn(f.store, "migrate");
    const result = await f.handler({
      ...request,
      ingestUrl: "http://ingest.example/",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { message: "Ingest URL must be an HTTPS origin" },
    });
    expect(migrate).not.toHaveBeenCalled();
  });
  it("applies the stack's retention and rate limit rules", async () => {
    const rateRejection = {
      issueRateLimit: { events: 10, windowSec: 60 },
    };
    const f = fixture({
      retentionDays: 7,
      maxRetentionDays: 7,
      rateRejection,
    });
    const ok = await f.handler({ ...request, rateLimits: { issueEvents: 4 } });
    expect(ok).toMatchObject({ ok: true, project: { retentionDays: 7 } });
    expect(
      await f.handler({ ...request, rateLimits: { issueEvents: 3 } }),
    ).toMatchObject({
      ok: false,
      error: { code: "Conflict" },
    });
    const looser = fixture({ rateRejection });
    expect(
      await looser.handler({ ...request, rateLimits: { issueEvents: 11 } }),
    ).toMatchObject({
      ok: false,
      error: { code: "Rejected", message: expect.stringContaining("exceeds") },
    });
    const disabled = fixture();
    expect(
      await disabled.handler({ ...request, rateLimits: { newIssues: 1 } }),
    ).toMatchObject({ ok: false, error: { code: "Rejected" } });
    const longer = fixture({ maxRetentionDays: 3 });
    expect(await longer.handler(request)).toMatchObject({
      ok: false,
      error: { code: "Rejected" },
    });
  });
  it("uses the deployment's secret name, validated from the environment", () => {
    expect(
      bootstrapSecretName({ ERRTRAQ_BOOTSTRAP_SECRET_NAME: "errtraq/b-1" }),
    ).toBe("errtraq/b-1");
    for (const env of [{}, { ERRTRAQ_BOOTSTRAP_SECRET_NAME: "bad name" }])
      expect(() => bootstrapSecretName(env)).toThrow(/bootstrap secret name/);
  });
});
