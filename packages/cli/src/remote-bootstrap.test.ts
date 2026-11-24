import { resolveStack } from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import grouped from "../../../stacks/aws-dynamodb.js";
import bootstrapStack from "../../../stacks/aws-dynamodb-bootstrap.js";
import {
  bootstrapFunctionName,
  formatRemoteBootstrap,
  invokeRemoteBootstrap,
  parseRemoteBootstrapResponse,
} from "./remote-bootstrap.js";

const copy = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value)) as T;
const stack = bootstrapStack;
const plain = grouped;
const environment = {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "secret-access-key-value",
  AWS_SESSION_TOKEN: "session-token-value",
};
const input = {
  orgSlug: "org",
  projectSlug: "project",
  ingestUrl: "https://ingest.example/",
};
const ok = {
  ok: true,
  version: 1,
  org: { id: "o1", slug: "org", created: true },
  project: { id: "1", slug: "project", retentionDays: 30, created: true },
  key: { created: true },
  token: { id: "t1", created: false },
  secret: {
    arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:b-ABC123",
    created: true,
  },
};
function fake(respond: (request: Request, body: string) => Response) {
  const seen: { url: string; headers: Headers; body: string }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), headers, body });
    return respond(new Request(String(url), { method: "POST", headers }), body);
  };
  return { fetcher, seen };
}

describe("remote bootstrap", () => {
  it("names the function from the stack and requires the role", () => {
    expect(bootstrapFunctionName(stack)).toBe(
      "aws-dynamodb-bootstrap-bootstrap",
    );
    expect(bootstrapFunctionName(stack, "renamed_fn")).toBe("renamed_fn");
    expect(() => bootstrapFunctionName(stack, "../x")).toThrow(/Invalid/);
    expect(() => bootstrapFunctionName(plain)).toThrow(/bootstrap role/);
  });
  it("sends a signed synchronous invocation with non-secret options only", async () => {
    const f = fake(() => Response.json(ok));
    const result = await invokeRemoteBootstrap(
      stack,
      environment,
      { ...input, rateLimits: {} },
      f.fetcher,
    );
    expect(result).toEqual(ok);
    const [call] = f.seen;
    expect(call?.url).toBe(
      "https://lambda.us-east-1.amazonaws.com/2015-03-31/functions/aws-dynamodb-bootstrap-bootstrap/invocations",
    );
    expect(call?.headers.get("x-amz-invocation-type")).toBe("RequestResponse");
    expect(call?.headers.get("x-amz-security-token")).toBe(
      "session-token-value",
    );
    expect(call?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/lambda\/aws4_request, SignedHeaders=.*x-amz-invocation-type.*, Signature=[a-f0-9]{64}$/,
    );
    expect(call?.headers.get("authorization")).not.toContain(
      "secret-access-key-value",
    );
    expect(JSON.parse(call?.body ?? "null")).toEqual({
      version: 1,
      ...input,
    });
  });
  it("sends rate limits and refuses ones the stack cannot honour before calling", async () => {
    const limited = resolveStack({
      ...copy(bootstrapStack),
      rateRejection: { issueRateLimit: { events: 10, windowSec: 60 } },
    });
    const f = fake(() => Response.json(ok));
    await invokeRemoteBootstrap(
      limited,
      environment,
      { ...input, rateLimits: { issueEvents: 4 } },
      f.fetcher,
    );
    expect(JSON.parse(f.seen[0]?.body ?? "null").rateLimits).toEqual({
      issueEvents: 4,
    });
    await expect(
      invokeRemoteBootstrap(
        limited,
        environment,
        { ...input, rateLimits: { issueEvents: 11 } },
        f.fetcher,
      ),
    ).rejects.toThrow(/exceeds the stack limit/);
    expect(f.seen).toHaveLength(1);
  });
  it("reports a failed bootstrap document as returned", async () => {
    const failure = {
      ok: false,
      version: 1,
      error: {
        code: "Conflict",
        message: "Bootstrap token is revoked or has changed",
      },
    };
    const f = fake(() => Response.json(failure));
    expect(
      await invokeRemoteBootstrap(stack, environment, input, f.fetcher),
    ).toEqual(failure);
  });
  it("scrubs provider text from HTTP errors", async () => {
    const leak = "db password hunter2 at db.internal";
    const f = fake(
      () =>
        new Response(
          JSON.stringify({ __type: "AccessDeniedException", Message: leak }),
          { status: 403 },
        ),
    );
    const error = await invokeRemoteBootstrap(
      stack,
      environment,
      input,
      f.fetcher,
    ).catch((value: unknown) => value);
    expect(String(error)).toBe(
      "Error: Lambda invocation failed (403): AccessDeniedException",
    );
    expect(JSON.stringify(error)).not.toContain("hunter2");
  });
  it("scrubs function errors down to the error type", async () => {
    const leak = "password authentication failed for user admin: hunter2";
    const f = fake(
      () =>
        new Response(
          JSON.stringify({
            errorMessage: leak,
            errorType: "Error",
            stackTrace: [leak],
          }),
          { status: 200, headers: { "x-amz-function-error": "Unhandled" } },
        ),
    );
    const error = await invokeRemoteBootstrap(
      stack,
      environment,
      input,
      f.fetcher,
    ).catch((value: unknown) => value);
    expect(String(error)).toBe(
      "Error: The bootstrap function failed (Error); see its CloudWatch log group",
    );
    // A hostile errorType is dropped rather than printed.
    const hostile = fake(
      () =>
        new Response(JSON.stringify({ errorType: `Bad ${leak}` }), {
          headers: { "x-amz-function-error": "Unhandled" },
        }),
    );
    const second = await invokeRemoteBootstrap(
      stack,
      environment,
      input,
      hostile.fetcher,
    ).catch((value: unknown) => value);
    expect(String(second)).not.toContain("hunter2");
    expect(String(second)).toContain("The bootstrap function failed;");
  });
  it("rejects unexpected response documents", async () => {
    for (const body of [
      { ok: true, version: 1 },
      { ...ok, version: 2 },
      { ...ok, project: { ...ok.project, retentionDays: "30" } },
      { ok: false, version: 1, error: { code: "bad code!", message: "x" } },
    ])
      expect(() => parseRemoteBootstrapResponse(body)).toThrow(/Unexpected/);
    const f = fake(() => Response.json({ hello: "world" }));
    await expect(
      invokeRemoteBootstrap(stack, environment, input, f.fetcher),
    ).rejects.toThrow(/Unexpected bootstrap function response/);
  });
  it("needs a region and credentials", async () => {
    const f = fake(() => Response.json(ok));
    await expect(
      invokeRemoteBootstrap(stack, {}, input, f.fetcher),
    ).rejects.toThrow(/region/);
    await expect(
      invokeRemoteBootstrap(
        stack,
        { AWS_REGION: "us-east-1" },
        input,
        f.fetcher,
      ),
    ).rejects.toThrow(/Lambda invocation failed: CredentialsUnavailable/);
    expect(f.seen).toHaveLength(0);
  });
  it("prints ids and flags, never a credential", () => {
    const parsed = parseRemoteBootstrapResponse(ok);
    if (!parsed.ok) throw new Error("expected success");
    const text = formatRemoteBootstrap(parsed);
    expect(text).toContain("Organization org (o1): created");
    expect(text).toContain("Bootstrap API token t1: already existed");
    expect(text).toContain(
      "read DSN and API token from Secrets Manager: arn:aws:secretsmanager",
    );
  });
});
