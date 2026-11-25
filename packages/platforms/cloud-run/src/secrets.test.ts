import { describe, expect, it, vi } from "vitest";
import {
  createSecretManagerSource,
  SecretReadError,
  versionResource,
} from "./secrets.js";

const id = "projects/example-project/secrets/db-admin";
const tokens = { getAccessToken: vi.fn(async () => "ya29.token") };
const payload = (text: string) =>
  Response.json({ payload: { data: btoa(text) } });

describe("Secret Manager source", () => {
  it("reads the latest version through the REST access call", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return payload("s3cret");
      },
    ) as unknown as typeof fetch;
    const source = createSecretManagerSource({ tokens, fetch: fetcher });
    expect(await source.read(id)).toBe("s3cret");
    expect(calls).toEqual([
      {
        url: `https://secretmanager.googleapis.com/v1/${id}/versions/latest:access`,
        auth: "Bearer ya29.token",
      },
    ]);
    expect(versionResource(`${id}/versions/3`)).toBe(`${id}/versions/3`);
  });
  it("caches within the TTL, shares in-flight reads and refreshes after expiry", async () => {
    let now = 0;
    const fetcher = vi.fn(async () => payload("v")) as unknown as typeof fetch;
    const source = createSecretManagerSource({
      tokens,
      fetch: fetcher,
      ttlMs: 1000,
      now: () => now,
    });
    await Promise.all([source.read(id), source.read(id)]);
    await source.read(id);
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 1001;
    await source.read(id);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects identifiers that are not Secret Manager resources", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const source = createSecretManagerSource({ tokens, fetch: fetcher });
    for (const bad of [
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:x-abcdef",
      "projects/p/secrets/",
      "projects/p/secrets/a/b",
      "projects/example-project/secrets/x/versions/0",
      "https://evil.example/",
    ])
      await expect(source.read(bad)).rejects.toMatchObject({
        providerCode: "InvalidIdentifier",
      });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("scrubs provider errors: no identifier, no body, no token", async () => {
    const secret = "leaked-value-123";
    const failing = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: `${id} ${secret}` } }),
          {
            status: 503,
          },
        ),
    ) as unknown as typeof fetch;
    const error = await createSecretManagerSource({ tokens, fetch: failing })
      .read(id)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretReadError);
    expect(error).toMatchObject({ providerCode: "HTTP503", retryable: true });
    expect(String((error as Error).message)).not.toContain(id);
    expect(JSON.stringify(error)).not.toContain(secret);
    const denied = await createSecretManagerSource({
      tokens,
      fetch: (async () => new Response("{}", { status: 403 })) as typeof fetch,
    })
      .read(id)
      .catch((e: unknown) => e);
    expect(denied).toMatchObject({ providerCode: "HTTP403", retryable: false });
    const broken = await createSecretManagerSource({
      tokens: {
        getAccessToken: async () => {
          throw new Error(`token ${secret}`);
        },
      },
      fetch: failing,
    })
      .read(id)
      .catch((e: unknown) => e);
    expect(JSON.stringify(broken)).not.toContain(secret);
    expect(String((broken as Error).message)).not.toContain(secret);
  });
  it("rejects malformed payloads", async () => {
    for (const body of [{}, { payload: {} }, { payload: { data: "***" } }]) {
      const source = createSecretManagerSource({
        tokens,
        fetch: (async () => Response.json(body)) as typeof fetch,
      });
      await expect(source.read(id)).rejects.toMatchObject({
        providerCode: "InvalidResponse",
      });
    }
  });
});
