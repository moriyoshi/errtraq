import { describe, expect, it } from "vitest";
import {
  coldStart,
  secretVersions,
  serviceAgent,
  serviceSettings,
} from "./deploy.mjs";
import { PROJECT, routerFetch, testContext } from "./testing.mjs";

const service = (fn, over = {}) => ({
  template: {
    serviceAccount: `gcp-g8-${fn}@${PROJECT}.iam.gserviceaccount.com`,
    maxInstanceRequestConcurrency:
      fn === "ingest" || fn === "api"
        ? 80
        : fn === "consumer" || fn === "record"
          ? 8
          : 1,
    scaling: { maxInstanceCount: 20 },
    containers: [
      {
        env: [{ name: "X" }],
        resources: { limits: { cpu: "1000m", memory: "512Mi" } },
      },
    ],
    ...over,
  },
});

describe("deploy probe", () => {
  it("accepts the designed settings and flags a different cap", async () => {
    const make = (over) =>
      routerFetch([
        [
          "GET",
          /services\/gcp-g8-(\w+)$/,
          (_u, _i, m) =>
            m[1] === "record"
              ? { status: 404 }
              : { body: service(m[1], m[1] === "cron" ? over : {}) },
        ],
      ]);
    const good = await testContext({ fetch: make({}) });
    await serviceSettings(good.ctx);
    expect(good.ctx.report.summary()).toMatchObject({ fail: 0, skip: 1 });
    const bad = await testContext({
      fetch: make({ scaling: { maxInstanceCount: 100 } }),
    });
    await serviceSettings(bad.ctx);
    expect(bad.output()).toContain(
      "FAIL service cron has the designed settings: max instances 100",
    );
  });
  it("measures the first and second request", async () => {
    const fetch = routerFetch([
      ["GET", /_errtraq\/health$/, () => ({ body: { status: "ok" } })],
    ]);
    const { ctx, output } = await testContext({
      fetch,
      outputs: {
        ingest_url: "https://i.test",
        api_url: "https://a.test",
        bootstrap_url: "https://b.test",
      },
    });
    await coldStart(ctx);
    expect(ctx.report.summary().fail).toBe(0);
    expect(output()).toContain("INFO cold start ingest");
  });
  it("requires one secret version and the agent grant", async () => {
    const one = await testContext({
      fetch: routerFetch([
        ["GET", /versions$/, () => ({ body: { versions: [{}] } })],
      ]),
    });
    await secretVersions(one.ctx);
    expect(one.ctx.report.summary().fail).toBe(0);
    const two = await testContext({
      fetch: routerFetch([
        ["GET", /versions$/, () => ({ body: { versions: [{}, {}] } })],
      ]),
    });
    await secretVersions(two.ctx);
    expect(two.ctx.report.summary().fail).toBe(1);
    const agent = await testContext({
      fetch: routerFetch([
        [
          "POST",
          /getIamPolicy$/,
          () => ({
            body: {
              bindings: [
                {
                  role: "roles/iam.serviceAccountTokenCreator",
                  members: [
                    "serviceAccount:service-1@gcp-sa-pubsub.iam.gserviceaccount.com",
                  ],
                },
              ],
            },
          }),
        ],
      ]),
    });
    await serviceAgent(agent.ctx);
    expect(agent.ctx.report.summary().fail).toBe(0);
  });
});
