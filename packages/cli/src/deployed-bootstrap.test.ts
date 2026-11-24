import {
  type BootstrapVault,
  bootstrapDeployed,
  hashApiToken,
} from "@moriyoshi/errtraq-core";
import { MemoryActiveStore, MemoryKV } from "@moriyoshi/errtraq-testing";
import { describe, expect, it, vi } from "vitest";
import stack from "../../../stacks/aws-dynamodb.js";
import { awsBootstrapVault, bootstrapAwsStack } from "./deployed-bootstrap.js";

const arn =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:bootstrap-ABC123";
function fixture() {
  const store = new MemoryActiveStore(),
    kv = new MemoryKV();
  let value: string | undefined;
  const vault: BootstrapVault = {
    async claim(_name, candidate) {
      value ??= candidate;
      return { identifier: arn, value };
    },
  };
  const options = {
    stackName: "stack",
    store,
    kv,
    vault,
    secretName: "bootstrap",
    ingestUrl: "https://ingest.example/",
    orgSlug: "org",
    projectSlug: "project",
  };
  return { store, options, getSecret: () => value };
}
describe("deployed bootstrap", () => {
  it("records bootstrap token metadata and backfills a pre-index token on rerun", async () => {
    const f = fixture();
    await bootstrapDeployed(f.options);
    const org = (await f.store.projects.getOrgBySlug("org"))?.id;
    if (!org) throw new Error("missing org");
    const listed = (await f.store.projects.listTokens(org)).items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ label: "bootstrap" });
    expect(listed[0]?.createdAt).toBeDefined();
    const hash = await hashApiToken(
      (JSON.parse(f.getSecret() ?? "{}") as { token: string }).token,
    );
    const stored = await f.store.projects.getTokenByHash(hash);
    if (!stored) throw new Error("missing token");
    const { createdAt: _c, label: _l, ...legacy } = stored;
    await f.store.projects.putToken(legacy);
    await bootstrapDeployed(f.options);
    const again = await f.store.projects.getTokenByHash(hash);
    expect(again?.createdAt).toBeDefined();
    expect(again?.label).toBe("bootstrap");
  });
  it("creates the project within the stack's maximum retention and rejects a longer existing one", async () => {
    const f = fixture();
    await bootstrapDeployed({
      ...f.options,
      retentionDays: 7,
      maxRetentionDays: 7,
    });
    const org = (await f.store.projects.getOrgBySlug("org"))?.id;
    if (!org) throw new Error("missing org");
    const project = await f.store.projects.getProjectBySlug(org, "project");
    expect(project?.retentionDays).toBe(7);
    await expect(
      bootstrapDeployed({ ...f.options, maxRetentionDays: 3 }),
    ).rejects.toThrow("exceeds the stack maximum");
    await expect(
      bootstrapDeployed({
        ...fixture().options,
        retentionDays: 90,
        maxRetentionDays: 30,
      }),
    ).rejects.toThrow("exceeds the stack maximum");
  });
  it("creates a project with tighter limits, rejects looser or disabled ones and differing reruns", async () => {
    const rateRejection = {
      issueRateLimit: { events: 10, windowSec: 60 },
      newIssueCap: { issues: 5, windowSec: 60 },
    };
    const f = fixture();
    const options = { ...f.options, rateRejection };
    await bootstrapDeployed({
      ...options,
      rateLimits: { issueEvents: 4, newIssues: 2 },
    });
    const org = (await f.store.projects.getOrgBySlug("org"))?.id;
    if (!org) throw new Error("missing org");
    expect(
      (await f.store.projects.getProjectBySlug(org, "project"))?.rateLimits,
    ).toEqual({ issueEvents: 4, newIssues: 2 });
    // Idempotent with the same limits (or none); a different value is a conflict.
    await bootstrapDeployed({
      ...options,
      rateLimits: { issueEvents: 4, newIssues: 2 },
    });
    await expect(
      bootstrapDeployed({ ...options, rateLimits: { issueEvents: 3 } }),
    ).rejects.toThrow(/different rate limits/);
    await expect(
      bootstrapDeployed({
        ...fixture().options,
        rateRejection,
        rateLimits: { issueEvents: 11 },
      }),
    ).rejects.toThrow(/exceeds the stack limit/);
    await expect(
      bootstrapDeployed({
        ...fixture().options,
        rateRejection: { issueRateLimit: rateRejection.issueRateLimit },
        rateLimits: { newIssues: 1 },
      }),
    ).rejects.toThrow(/does not enable/);
    const none = fixture();
    await bootstrapDeployed({ ...none.options, rateRejection });
    const noneOrg = (await none.store.projects.getOrgBySlug("org"))?.id;
    if (!noneOrg) throw new Error("missing org");
    const created = await none.store.projects.getProjectBySlug(
      noneOrg,
      "project",
    );
    expect(created).not.toBeNull();
    expect(created?.rateLimits).toBeUndefined();
  });
  it("constructs only the deployed store and KV with delivered bindings", async () => {
    const f = fixture();
    const seen: string[] = [];
    const result = await bootstrapAwsStack(
      stack,
      { ERRTRAQ_STORE_TABLE: "store-table", ERRTRAQ_KV_TABLE: "kv-table" },
      {
        secretName: "bootstrap",
        ingestUrl: "https://ingest.example/",
        orgSlug: "org",
        projectSlug: "project",
      },
      {
        vault: f.options.vault,
        secretSource: {
          read: async () => {
            throw new Error("Unexpected secret read");
          },
        },
        loadModule: async (name) => ({
          create: (context: { bindings: Record<string, string> }) => {
            seen.push(name);
            if (name.includes("store-dynamodb")) {
              expect(context.bindings.ERRTRAQ_STORE_TABLE).toBe("store-table");
              return f.store;
            }
            expect(context.bindings.ERRTRAQ_KV_TABLE).toBe("kv-table");
            return f.options.kv;
          },
        }),
      },
    );
    expect(result).toBe(arn);
    expect(seen.sort()).toEqual([
      "@moriyoshi/errtraq-kv-dynamodb/runtime",
      "@moriyoshi/errtraq-store-dynamodb/runtime",
    ]);
  });
  it("converges concurrent and repeated calls on one stored token and DSN", async () => {
    const f = fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => bootstrapDeployed(f.options)),
    );
    expect(results).toEqual(Array(8).fill(arn));
    const secret = JSON.parse(f.getSecret() ?? "null");
    expect(secret.dsn).toMatch(/^https:\/\/[a-f0-9]+@ingest\.example\/\d+$/);
    expect(secret.token).toMatch(/^errtraq_[a-f0-9]{64}$/);
    expect(
      await f.store.projects.getTokenByHash(await hashApiToken(secret.token)),
    ).toMatchObject({
      orgId: secret.orgId,
      scopes: ["event:read", "event:write"],
    });
    expect(await bootstrapDeployed(f.options)).toBe(arn);
    expect(JSON.parse(f.getSecret() ?? "null")).toEqual(secret);
  });
  it("does not create credentials when migration fails", async () => {
    const f = fixture();
    vi.spyOn(f.store, "migrate").mockRejectedValueOnce(
      new Error("migration failed"),
    );
    await expect(bootstrapDeployed(f.options)).rejects.toThrow(
      "migration failed",
    );
    expect(f.getSecret()).toBeUndefined();
  });
  it("resumes safely if token registration fails after the secret was created", async () => {
    const f = fixture();
    const original = f.store.projects.createToken.bind(f.store.projects);
    vi.spyOn(f.store.projects, "createToken")
      .mockRejectedValueOnce(new Error("interrupted"))
      .mockImplementation(original);
    await expect(bootstrapDeployed(f.options)).rejects.toThrow("interrupted");
    const secret = JSON.parse(f.getSecret() ?? "null");
    expect(await bootstrapDeployed(f.options)).toBe(arn);
    expect(
      await f.store.projects.getTokenByHash(await hashApiToken(secret.token)),
    ).not.toBeNull();
  });
  it("rejects another deployment's secret without disclosing its contents", async () => {
    const f = fixture();
    await bootstrapDeployed(f.options);
    const error = await bootstrapDeployed({
      ...f.options,
      stackName: "other",
    }).catch((value: unknown) => value);
    expect(String(error)).toContain("does not match");
    expect(String(error)).not.toContain(
      JSON.parse(f.getSecret() ?? "null").token,
    );
  });
  it("does not reactivate a revoked bootstrap token on a later run", async () => {
    const f = fixture();
    await bootstrapDeployed(f.options);
    const saved = JSON.parse(f.getSecret() ?? "null");
    const token = await f.store.projects.getTokenByHash(
      await hashApiToken(saved.token),
    );
    if (!token) throw new Error("Missing token");
    await f.store.projects.putToken({
      ...token,
      revokedAt:
        "2025-01-01T00:00:00.000Z" as import("@moriyoshi/errtraq-core").Timestamp,
    });
    await expect(bootstrapDeployed(f.options)).rejects.toThrow(
      "revoked or has changed",
    );
    expect(
      (await f.store.projects.getTokenByHash(token.tokenHash))?.revokedAt,
    ).toBeDefined();
  });
  it("uses Secrets Manager create-or-read and never exposes provider messages", async () => {
    const calls: string[] = [];
    let describes = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      const action = new Headers(init?.headers).get("x-amz-target") ?? "";
      calls.push(action);
      if (action.endsWith("CreateSecret"))
        return Response.json(
          {
            __type: "ResourceExistsException",
            message: "do not log this secret",
          },
          { status: 400 },
        );
      if (action.endsWith("DescribeSecret"))
        return ++describes === 1
          ? Response.json(
              { __type: "ResourceNotFoundException" },
              { status: 400 },
            )
          : Response.json({ ARN: arn });
      if (action.endsWith("GetSecretValue"))
        return Response.json({ SecretString: "authoritative" });
      throw new Error("Unexpected request");
    };
    const vault = awsBootstrapVault(
      {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "id",
        AWS_SECRET_ACCESS_KEY: "key",
      },
      fetcher,
    );
    expect(await vault.claim("bootstrap", "candidate")).toEqual({
      identifier: arn,
      value: "authoritative",
    });
    expect(calls).toEqual([
      "secretsmanager.CreateSecret",
      "secretsmanager.DescribeSecret",
      "secretsmanager.DescribeSecret",
      "secretsmanager.GetSecretValue",
    ]);
  });
  it("does not expose a secret candidate when Secrets Manager rejects creation", async () => {
    const candidate = "secret-bootstrap-token-and-dsn";
    const vault = awsBootstrapVault(
      {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "id",
        AWS_SECRET_ACCESS_KEY: "key",
      },
      async () =>
        Response.json(
          { __type: "AccessDeniedException", message: candidate },
          { status: 400 },
        ),
    );
    const error = await vault
      .claim("bootstrap", candidate)
      .catch((value: unknown) => value);
    expect(String(error)).not.toContain(candidate);
    expect(JSON.stringify(error)).not.toContain(candidate);
  });
  it("creates the secret with an idempotency token and keeps credentials out of errors", async () => {
    const candidate = "private-bootstrap-payload";
    const vault = awsBootstrapVault(
      {
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "id",
        AWS_SECRET_ACCESS_KEY: "key",
        AWS_SESSION_TOKEN: "session",
      },
      async (_url, init) => {
        expect(new Headers(init?.headers).get("x-amz-security-token")).toBe(
          "session",
        );
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          Name: "bootstrap",
          SecretString: candidate,
        });
        expect(body.ClientRequestToken).toMatch(/^[0-9a-f-]{36}$/);
        return Response.json({ ARN: arn });
      },
    );
    expect(await vault.claim("bootstrap", candidate)).toEqual({
      identifier: arn,
      value: candidate,
    });
  });
});
