import { resolveStack, type StackConfig } from "@moriyoshi/errtraq-core";
import { MemoryActiveStore, MemoryKV } from "@moriyoshi/errtraq-testing";
import { describe, expect, it, vi } from "vitest";
import example from "../../../stacks/gcp-firestore.js";
import {
  bootstrapCloudRunStack,
  openDeployedStack,
} from "./deployed-bootstrap.js";
import type { OperatorGcpCredentials } from "./gcp-credentials.js";
import { invokeCloudRunBootstrap } from "./remote-bootstrap.js";

vi.hoisted(() => {
  process.env.ERRTRAQ_GCP_PROJECT = "example-project";
  process.env.ERRTRAQ_GCP_REGION = "europe-west1";
});
const base = Object.fromEntries(Object.entries(example)) as StackConfig;
const roles = ["ingest", "api", "consumer", "record", "cron", "bootstrap"];
const withBootstrap = resolveStack({
  ...base,
  platform: {
    ...base.platform,
    config: {
      ...(base.platform.config as object),
      roles,
      split: roles,
      bootstrapSecretName: "errtraq-bootstrap",
    },
  },
});
const credentials = (): OperatorGcpCredentials => ({
  tokens: {
    getAccessToken: vi.fn(async () => "ya29.operator"),
    getIdToken: vi.fn(async () => "id.token.sig"),
  },
  email: "operator@example-project.iam.gserviceaccount.com",
});
const okBody = {
  ok: true,
  version: 1,
  org: { id: "1", slug: "org", created: true },
  project: { id: "2", slug: "project", retentionDays: 30, created: true },
  key: { created: true },
  token: { id: "3", created: true },
  secret: {
    arn: "projects/example-project/secrets/errtraq-bootstrap/versions/1",
    created: true,
  },
};
describe("remote bootstrap on Cloud Run", () => {
  const input = {
    orgSlug: "org",
    projectSlug: "project",
    ingestUrl: "https://ingest.example/",
    serviceUrl: "https://bootstrap-abc-ew.a.run.app",
  };
  it("posts the request with an ID token for the stack's OIDC audience", async () => {
    const creds = credentials();
    const calls: { url: string; headers: Headers; body: unknown }[] = [];
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(okBody);
      },
    ) as unknown as typeof fetch;
    const result = await invokeCloudRunBootstrap(
      withBootstrap,
      creds,
      input,
      fetcher,
    );
    expect(result).toMatchObject({ ok: true, secret: { created: true } });
    expect(creds.tokens.getIdToken).toHaveBeenCalledWith("errtraq-push");
    expect(calls[0]?.url).toBe(
      "https://bootstrap-abc-ew.a.run.app/_errtraq/bootstrap",
    );
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer id.token.sig");
    expect(calls[0]?.body).toMatchObject({
      version: 1,
      orgSlug: "org",
      ingestUrl: "https://ingest.example/",
    });
    // No credentials in the body.
    expect(JSON.stringify(calls[0]?.body)).not.toContain("id.token.sig");
  });
  it("reports status only and rejects unsafe URLs and stacks without the role", async () => {
    const denied = (async () =>
      new Response("secret detail", { status: 403 })) as typeof fetch;
    await expect(
      invokeCloudRunBootstrap(withBootstrap, credentials(), input, denied),
    ).rejects.toThrow(/\(403\).*roles\/run\.invoker/);
    await expect(
      invokeCloudRunBootstrap(withBootstrap, credentials(), input, denied),
    ).rejects.not.toThrow(/secret detail/);
    for (const serviceUrl of [
      "http://bootstrap.example/",
      "https://user:pw@bootstrap.example/",
      "https://bootstrap.example/path",
      "https://bootstrap.example/?x=1",
      "not a url",
    ])
      await expect(
        invokeCloudRunBootstrap(withBootstrap, credentials(), {
          ...input,
          serviceUrl,
        }),
      ).rejects.toThrow(/service-url/i);
    await expect(
      invokeCloudRunBootstrap(example, credentials(), input),
    ).rejects.toThrow("does not deploy the bootstrap role");
  });
  it("rejects a malformed response", async () => {
    const bad = (async () =>
      Response.json({ ok: true, version: 1 })) as typeof fetch;
    await expect(
      invokeCloudRunBootstrap(withBootstrap, credentials(), input, bad),
    ).rejects.toThrow("Unexpected bootstrap function response");
  });
});
describe("operator commands on Cloud Run", () => {
  function fakeModules() {
    const seen: Record<string, Record<string, unknown>> = {};
    const load = vi.fn(async (name: string) => ({
      create: (context: { bindings: Record<string, unknown> }) => {
        seen[name] = context.bindings;
        return name.includes("kv") ? new MemoryKV() : new MemoryActiveStore();
      },
    }));
    return { seen, load };
  }
  const environment = {
    ERRTRAQ_STORE_DATABASE: "(default)",
    ERRTRAQ_KV_DATABASE: "kv",
  };
  it("hands the operator's token source to the Firestore adapters as accessToken", async () => {
    const { seen, load } = fakeModules();
    const creds = credentials();
    const opened = await openDeployedStack(withBootstrap, environment, {
      loadModule: load,
      gcp: creds,
    });
    await opened.close();
    expect(Object.keys(seen).sort()).toEqual([
      "@moriyoshi/errtraq-kv-firestore/runtime",
      "@moriyoshi/errtraq-store-firestore/runtime",
    ]);
    for (const bindings of Object.values(seen))
      expect(await (bindings.accessToken as () => Promise<string>)()).toBe(
        "ya29.operator",
      );
    expect(creds.tokens.getAccessToken).toHaveBeenCalledWith([
      "https://www.googleapis.com/auth/cloud-platform",
    ]);
  });
  it("bootstraps through a Secret Manager vault", async () => {
    const { load } = fakeModules();
    const secrets = new Map<string, string>();
    const vault = {
      claim: vi.fn(async (name: string, candidate: string) => {
        const value = secrets.get(name) ?? candidate;
        secrets.set(name, value);
        return {
          identifier: `projects/example-project/secrets/${name}/versions/1`,
          value,
        };
      }),
    };
    const identifier = await bootstrapCloudRunStack(
      withBootstrap,
      environment,
      {
        secretName: "errtraq-bootstrap",
        ingestUrl: "https://ingest.example/",
        orgSlug: "org",
        projectSlug: "project",
      },
      { loadModule: load, gcp: credentials(), vault },
    );
    expect(identifier).toBe(
      "projects/example-project/secrets/errtraq-bootstrap/versions/1",
    );
    expect(secrets.get("errtraq-bootstrap")).toContain("dsn");
  });
  it("refuses platforms it cannot reach", async () => {
    const { default: aws } = await import("../../../stacks/aws-dynamodb.js");
    await expect(
      bootstrapCloudRunStack(
        aws,
        {},
        {
          secretName: "x",
          ingestUrl: "https://i.example/",
          orgSlug: "o",
          projectSlug: "p",
        },
      ),
    ).rejects.toThrow("Expected a Cloud Run stack");
  });
});
