import { describe, expect, it, vi } from "vitest";
import { resolveOperatorGcpCredentials } from "./gcp-credentials.js";

const files = (map: Record<string, string>) => async (path: string) => {
  const text = map[path];
  if (text === undefined) throw new Error("ENOENT");
  return text;
};
describe("operator GCP credentials", () => {
  it("uses an authorized-user ADC file to refresh access tokens and never mints an ID token", async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return Response.json({ access_token: "ya29.u", expires_in: 3600 });
    }) as unknown as typeof fetch;
    const credentials = await resolveOperatorGcpCredentials(
      {},
      {
        homeDirectory: "/home/op",
        fetch: fetcher,
        readFile: files({
          "/home/op/.config/gcloud/application_default_credentials.json":
            JSON.stringify({
              type: "authorized_user",
              client_id: "c",
              client_secret: "s",
              refresh_token: "r",
            }),
        }),
      },
    );
    expect(await credentials.tokens.getAccessToken()).toBe("ya29.u");
    expect(credentials.email).toBeUndefined();
    await expect(credentials.tokens.getIdToken("aud")).rejects.toThrow(
      /ERRTRAQ_GCP_ID_TOKEN/,
    );
  });
  it("lets a pre-minted ID token stand in for the one the credentials cannot mint", async () => {
    const credentials = await resolveOperatorGcpCredentials(
      {
        ERRTRAQ_GCP_ID_TOKEN: "id.token.sig",
        GOOGLE_APPLICATION_CREDENTIALS: "/k.json",
      },
      {
        fetch: (async () =>
          Response.json({
            access_token: "a",
            expires_in: 3600,
          })) as typeof fetch,
        readFile: files({
          "/k.json": JSON.stringify({
            type: "authorized_user",
            client_id: "c",
            client_secret: "s",
            refresh_token: "r",
          }),
        }),
      },
    );
    expect(await credentials.tokens.getIdToken("any")).toBe("id.token.sig");
  });
  it("prefers the named file and fails clearly when it is missing, malformed or unsupported", async () => {
    const run = (path: string, map: Record<string, string>) =>
      resolveOperatorGcpCredentials(
        { GOOGLE_APPLICATION_CREDENTIALS: path },
        { readFile: files(map) },
      );
    await expect(run("/missing.json", {})).rejects.toThrow(
      "Cannot read GOOGLE_APPLICATION_CREDENTIALS",
    );
    await expect(run("/k.json", { "/k.json": "{" })).rejects.toThrow(
      "not valid JSON",
    );
    await expect(
      run("/k.json", {
        "/k.json": JSON.stringify({ type: "external_account" }),
      }),
    ).rejects.toThrow("Unsupported Google credentials file type");
  });
  it("errors when nothing resolves, without echoing paths or file text", async () => {
    await expect(
      resolveOperatorGcpCredentials({}, { readFile: files({}) }),
    ).rejects.toThrow("gcloud auth application-default login");
    const none = await resolveOperatorGcpCredentials(
      {},
      { readFile: files({}), required: false },
    );
    await expect(none.tokens.getAccessToken()).rejects.toThrow(
      "No Google credentials",
    );
  });
  it("follows the metadata server only when it is named", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ access_token: "ya29.m", expires_in: 3600 }),
    ) as unknown as typeof fetch;
    const credentials = await resolveOperatorGcpCredentials(
      { GCE_METADATA_HOST: "metadata.test" },
      { readFile: files({}), fetch: fetcher },
    );
    expect(await credentials.tokens.getAccessToken()).toBe("ya29.m");
  });
});
