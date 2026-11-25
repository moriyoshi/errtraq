import { describe, expect, it, vi } from "vitest";
import {
  bootstrapSecretName,
  createBootstrapHandler,
  gcpBootstrapVault,
} from "./bootstrap.js";

const tokens = { getAccessToken: async () => "ya29.token" };
const project = "example-project";
/** A tiny Secret Manager: secrets and their versions, with the REST paths the vault uses. */
function fakeSecretManager() {
  const secrets = new Map<string, string[]>();
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const create = /^\/v1\/projects\/[^/]+\/secrets$/.exec(url.pathname);
    if (create && init?.method === "POST") {
      const id = url.searchParams.get("secretId") ?? "";
      if (secrets.has(id)) return new Response("{}", { status: 409 });
      secrets.set(id, []);
      return Response.json({ name: `projects/${project}/secrets/${id}` });
    }
    const add = /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+):addVersion$/.exec(
      url.pathname,
    );
    if (add) {
      const versions = secrets.get(add[1] ?? "");
      if (!versions) return new Response("{}", { status: 404 });
      const body = JSON.parse(String(init?.body)) as {
        payload: { data: string };
      };
      versions.push(atob(body.payload.data));
      return Response.json({
        name: `projects/${project}/secrets/${add[1]}/versions/${versions.length}`,
      });
    }
    const access =
      /^\/v1\/projects\/[^/]+\/secrets\/([^/:]+)\/versions\/(\d+):access$/.exec(
        url.pathname,
      );
    if (access) {
      const value = secrets.get(access[1] ?? "")?.[Number(access[2]) - 1];
      return value === undefined
        ? new Response("{}", { status: 404 })
        : Response.json({ payload: { data: btoa(value) } });
    }
    return new Response("{}", { status: 400 });
  }) as typeof fetch;
  return { secrets, calls, fetcher };
}
const vault = (fetcher: typeof fetch) =>
  gcpBootstrapVault({
    projectId: project,
    tokens,
    fetch: fetcher,
    sleep: async () => {},
  });

describe("Secret Manager bootstrap vault", () => {
  it("creates the secret and version 1, returning the candidate as created", async () => {
    const sm = fakeSecretManager();
    const result = await vault(sm.fetcher).claim(
      "errtraq-bootstrap",
      '{"dsn":1}',
    );
    expect(result).toEqual({
      identifier: `projects/${project}/secrets/errtraq-bootstrap/versions/1`,
      value: '{"dsn":1}',
      created: true,
    });
    expect(sm.secrets.get("errtraq-bootstrap")).toEqual(['{"dsn":1}']);
  });
  it("converges on version 1 for a second caller and never overwrites it", async () => {
    const sm = fakeSecretManager();
    await vault(sm.fetcher).claim("s", "first");
    const second = await vault(sm.fetcher).claim("s", "second");
    expect(second).toMatchObject({ value: "first" });
    expect(second).not.toHaveProperty("created");
    expect(sm.secrets.get("s")).toEqual(["first"]);
  });
  it("adds a version when the winner created the secret but never wrote one", async () => {
    const sm = fakeSecretManager();
    sm.secrets.set("s", []);
    const result = await vault(sm.fetcher).claim("s", "mine");
    expect(result).toMatchObject({ value: "mine", created: true });
  });
  it("reads back version 1 when a racing writer won it", async () => {
    const sm = fakeSecretManager();
    sm.secrets.set("s", []);
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (
        String(input).endsWith(":addVersion") &&
        sm.secrets.get("s")?.length === 0
      )
        sm.secrets.get("s")?.push("theirs");
      return sm.fetcher(input, init);
    }) as typeof fetch;
    const result = await vault(racing).claim("s", "mine");
    expect(result).toMatchObject({ value: "theirs" });
    expect(result).not.toHaveProperty("created");
  });
  it("scrubs failures and rejects names the IAM condition would not allow", async () => {
    const failing = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED secret-value");
    }) as unknown as typeof fetch;
    await expect(vault(failing).claim("s", "x")).rejects.toThrow(
      "Secret Manager bootstrap operation failed",
    );
    const denied = (async () =>
      new Response("{}", { status: 403 })) as typeof fetch;
    await expect(vault(denied).claim("s", "x")).rejects.toThrow(
      "Unable to create bootstrap secret",
    );
    await expect(vault(failing).claim("a/b", "x")).rejects.toThrow(
      "Invalid bootstrap secret name",
    );
    expect(() =>
      gcpBootstrapVault({ projectId: "Bad Project", tokens }),
    ).toThrow("Invalid Google project id");
  });
});
describe("bootstrap handler", () => {
  it("reads the one allowed secret name from the environment", () => {
    expect(
      bootstrapSecretName({
        ERRTRAQ_BOOTSTRAP_SECRET_NAME: "errtraq-bootstrap",
      }),
    ).toBe("errtraq-bootstrap");
    for (const env of [{}, { ERRTRAQ_BOOTSTRAP_SECRET_NAME: "a/b" }])
      expect(() => bootstrapSecretName(env)).toThrow();
  });
  it("answers an invalid request with a scrubbed error document", async () => {
    const handler = createBootstrapHandler({
      stackName: "s",
      store: {} as never,
      kv: {} as never,
      vault: { claim: async () => ({ identifier: "x", value: "y" }) },
      secretName: "errtraq-bootstrap",
    });
    const response = await handler({ version: 99 });
    expect(response).toMatchObject({ ok: false });
  });
});
