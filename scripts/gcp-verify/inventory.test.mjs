import { describe, expect, it } from "vitest";
import { inventory } from "./inventory.mjs";
import { PROJECT, routerFetch, testContext } from "./testing.mjs";

function world(left) {
  return routerFetch([
    [
      "GET",
      /run\.googleapis/,
      () => ({
        body: left
          ? {
              services: [
                {
                  name: `projects/${PROJECT}/locations/x/services/gcp-g8-ingest`,
                },
                { name: "projects/p/locations/x/services/other" },
              ],
            }
          : {},
      }),
    ],
    [
      "GET",
      /secretmanager/,
      () => ({
        body: {
          secrets: [{ name: `projects/1/secrets/errtraq-bootstrap-gcp-g8` }],
        },
      }),
    ],
    ["GET", /serviceusage/, () => ({ body: { services: [{}, {}] } })],
    [
      "GET",
      /iam\.googleapis\.com.*roles/,
      () => ({
        body: {
          roles: [
            {
              name: `projects/${PROJECT}/roles/gcp_g8_blob_read`,
              deleted: true,
            },
          ],
        },
      }),
    ],
    ["GET", /./, () => ({ body: {} })],
  ]);
}

describe("inventory probe", () => {
  it("passes when only resources outside Terraform remain", async () => {
    const { ctx, output } = await testContext({ fetch: world(false) });
    const result = await inventory(ctx);
    expect(result).toEqual({ owned: 0, outside: 1 });
    expect(ctx.report.summary().fail).toBe(0);
    expect(output()).toContain("INFO Soft-deleted custom roles: 1");
    expect(output()).not.toContain(PROJECT);
  });
  it("fails on a Terraform-owned leftover and only lists it in present mode", async () => {
    const left = await testContext({ fetch: world(true) });
    await inventory(left.ctx);
    expect(left.output()).toContain(
      "FAIL Cloud Run services: 1 left (gcp-g8-ingest)",
    );
    const present = await testContext({
      fetch: world(true),
      flags: { expect: "present" },
    });
    await inventory(present.ctx);
    expect(present.ctx.report.summary().fail).toBe(0);
  });
  it("reports a listing error as a failure", async () => {
    const { ctx } = await testContext({
      fetch: routerFetch([["GET", /./, () => ({ status: 403 })]]),
    });
    await inventory(ctx);
    expect(ctx.report.summary().fail).toBeGreaterThan(5);
  });
  it("sends only the page sizes each API accepts (an oversized one is a 400)", async () => {
    // Limits observed on real GCP (G8 run 1).
    const limits = [
      [/firestore\.googleapis/, 0],
      [/iam\.googleapis\.com.*serviceAccounts/, 100],
      [/serviceusage/, 200],
    ];
    const urls = [];
    const fetch = async (url) => {
      urls.push(String(url));
      const size = Number(new URL(String(url)).searchParams.get("pageSize"));
      const limit = limits.find(([pattern]) => pattern.test(String(url)));
      const refused = limit && size > limit[1];
      return new Response("{}", {
        status: refused ? 400 : 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { ctx, output } = await testContext({ fetch });
    await inventory(ctx);
    expect(ctx.report.summary().fail).toBe(0);
    expect(output()).toContain("INFO Enabled APIs left on: 0");
    expect(urls.some((url) => /firestore/.test(url))).toBe(true);
  });
  it("counts a deleted registry repository as no images left", async () => {
    const { ctx, output } = await testContext({
      env: { ERRTRAQ_GCP_AR_REPO: "errtraq" },
      fetch: routerFetch([
        ["GET", /artifactregistry/, () => ({ status: 404 })],
        ["GET", /./, () => ({ body: {} })],
      ]),
    });
    await inventory(ctx);
    expect(ctx.report.summary().fail).toBe(0);
    expect(output()).toContain(
      "Artifact Registry images (outside Terraform): 0",
    );
  });
});
