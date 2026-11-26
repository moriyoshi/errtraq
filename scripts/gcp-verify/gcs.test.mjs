import { describe, expect, it } from "vitest";
import {
  bucketSettings,
  conditionalWrite,
  listPaging,
  notFoundWording,
  signedUrl,
} from "./gcs.mjs";
import { PROJECT, routerFetch, testContext } from "./testing.mjs";

describe("gcs probe", () => {
  it("checks the bucket settings", async () => {
    const bucket = (over = {}) => ({
      location: "EUROPE-WEST1",
      iamConfiguration: {
        uniformBucketLevelAccess: { enabled: true },
        publicAccessPrevention: "enforced",
      },
      softDeletePolicy: { retentionDurationSeconds: "0" },
      lifecycle: { rule: [1, 2, 3, 4] },
      ...over,
    });
    const good = await testContext({
      fetch: routerFetch([
        ["GET", /storage\/v1\/b\/gcp-g8-/, () => ({ body: bucket() })],
      ]),
    });
    await bucketSettings(good.ctx);
    expect(good.ctx.report.summary().fail).toBe(0);
    const soft = await testContext({
      fetch: routerFetch([
        [
          "GET",
          /storage\/v1\/b\/gcp-g8-/,
          () => ({
            body: bucket({
              softDeletePolicy: { retentionDurationSeconds: "604800" },
            }),
          }),
        ],
      ]),
    });
    await bucketSettings(soft.ctx);
    expect(soft.output()).toContain("FAIL soft delete is disabled");
    expect(soft.output()).not.toContain(PROJECT);
  });

  it("expects create-only writes to fail the second time", async () => {
    let exists = false;
    let generation = 0;
    const deleted = [];
    const fetch = routerFetch([
      [
        "POST",
        /uploadType=media/,
        (url) => {
          if (url.includes("ifGenerationMatch=0") && exists)
            return { status: 412 };
          if (
            url.includes("ifGenerationMatch=") &&
            !url.includes("=0") &&
            !url.includes(`=${generation}&`) &&
            !url.endsWith(`=${generation}`)
          )
            return { status: 412 };
          exists = true;
          generation += 1;
          return { body: { generation: String(generation) } };
        },
      ],
      [
        "DELETE",
        /./,
        (url) => {
          deleted.push(url);
          return { status: 204 };
        },
      ],
    ]);
    const { ctx, output } = await testContext({ fetch });
    await conditionalWrite(ctx);
    expect(output()).toContain(
      "PASS a create-only write succeeds once and then fails with 412",
    );
    expect(deleted).toHaveLength(1);
  });

  it("classifies the 404 bodies", async () => {
    const fetch = routerFetch([
      [
        "GET",
        /\/o\/g8-probe/,
        () => ({
          status: 404,
          body: { error: { message: "No such object: x/y" } },
        }),
      ],
      [
        "GET",
        /g8-absent/,
        () => ({
          status: 404,
          body: { error: { message: "The specified bucket does not exist." } },
        }),
      ],
    ]);
    const { ctx, output } = await testContext({ fetch });
    await notFoundWording(ctx);
    expect(ctx.report.summary().fail).toBe(0);
    expect(output()).toContain("INFO 404 bodies");
  });

  it("pages through more than 1000 objects and cleans up", async () => {
    const store = new Map();
    const blob = async () => ({
      put: async (key) => void store.set(key, 1),
      delete: async (key) => void store.delete(key),
      list: async (prefix, cursor, limit) => {
        const keys = [...store.keys()]
          .filter((key) => key.startsWith(prefix))
          .sort();
        const start = Number(cursor ?? 0);
        const items = keys.slice(start, start + limit);
        return {
          items,
          nextCursor:
            start + limit < keys.length ? String(start + limit) : null,
        };
      },
    });
    const fetch = routerFetch([
      [
        "GET",
        /maxResults=1000/,
        () => ({
          body: { items: new Array(1000).fill({}), nextPageToken: "t" },
        }),
      ],
    ]);
    const { ctx, output } = await testContext({
      fetch,
      deps: { createBlobStore: blob },
    });
    await listPaging(ctx);
    expect(output()).toContain(
      "PASS listing above 1000 objects returns every key once, in order: 1205 of 1205 in 2 pages",
    );
    expect(output()).toContain("PASS probe objects deleted");
    expect(store.size).toBe(0);
  });

  it("skips signing without a signer and verifies tampering with one", async () => {
    const skipped = await testContext({ fetch: routerFetch([]) });
    await signedUrl(skipped.ctx);
    expect(skipped.output()).toContain("SKIP signed URL");
    const blob = async () => ({
      put: async () => {},
      delete: async () => {},
      presign: async () => "https://storage.example/o?X-Goog-Signature=abcd",
    });
    const fetch = routerFetch([
      ["GET", /X-Goog-Signature=abcd/, () => new Response("signed-body")],
      ["GET", /X-Goog-Signature=/, () => ({ status: 403 })],
    ]);
    const signed = await testContext({
      fetch,
      flags: { "signer-sa": "sa@x.iam.gserviceaccount.com" },
      deps: { createBlobStore: blob },
    });
    await signedUrl(signed.ctx);
    expect(signed.ctx.report.summary()).toMatchObject({ fail: 0, pass: 2 });
  });
});
