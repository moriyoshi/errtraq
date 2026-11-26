import { describe, expect, it } from "vitest";
import { jobConfiguration, recovery } from "./scheduler-cron.mjs";
import { dataOf, PROJECT, routerFetch, testContext } from "./testing.mjs";

const cron = "https://cron-hash.a.run.app";
const job = (name, over = {}) => ({
  state: "ENABLED",
  schedule: name === "staged-recovery" ? "*/5 * * * *" : "*/15 * * * *",
  httpTarget: {
    httpMethod: "POST",
    uri: `${cron}/_errtraq/cron/${name}`,
    oidcToken: {
      audience: "errtraq-push",
      serviceAccountEmail: `errtraq-scheduler@${PROJECT}.iam.gserviceaccount.com`,
    },
  },
  lastAttemptTime: "2026-01-01T00:00:00Z",
  ...over,
});
const base = [
  ["GET", /services\/gcp-g8-cron$/, () => ({ body: { uri: cron } })],
  ["POST", /cron-hash.*cron\/staged-recovery$/, () => ({ status: 401 })],
];

describe("cron probe", () => {
  it("verifies both jobs and rejects a wrong audience", async () => {
    const make = (audience) =>
      routerFetch([
        ...base,
        [
          "GET",
          /jobs\/gcp-g8-(.*)$/,
          (_u, _i, m) => ({
            body: job(
              m[1],
              audience
                ? {
                    httpTarget: {
                      ...job(m[1]).httpTarget,
                      oidcToken: { audience, serviceAccountEmail: "x" },
                    },
                  }
                : {},
            ),
          }),
        ],
      ]);
    const good = await testContext({ fetch: make() });
    await jobConfiguration(good.ctx);
    expect(good.ctx.report.summary().fail).toBe(0);
    const bad = await testContext({ fetch: make("other") });
    await jobConfiguration(bad.ctx);
    expect(bad.ctx.report.summary().fail).toBe(2);
  });
  it("recovers a planted envelope after a forced run", async () => {
    let ran = false;
    const fetch = routerFetch([
      [
        "GET",
        /secretmanager/,
        () => ({
          body: {
            payload: {
              data: dataOf({ dsn: "https://k@ingest.test/7", token: "t" }),
            },
          },
        }),
      ],
      ["POST", /uploadType=media/, () => ({ body: {} })],
      [
        "POST",
        /staged-recovery:run$/,
        () => {
          ran = true;
          return { body: {} };
        },
      ],
      [
        "GET",
        /api\.test.*issues/,
        () => ({
          body: ran ? [{ title: "g8 recovered abc123", count: "1" }] : [],
        }),
      ],
      [
        "GET",
        /jobs\/gcp-g8-staged-recovery$/,
        () => ({ body: job("staged-recovery") }),
      ],
      ["DELETE", /./, () => ({ status: 204 })],
    ]);
    const { ctx, output } = await testContext({
      fetch,
      outputs: { api_url: "https://api.test" },
    });
    await recovery(ctx);
    expect(ctx.report.summary()).toMatchObject({ fail: 0, pass: 4 });
    expect(output()).not.toContain(PROJECT);
  });
});
