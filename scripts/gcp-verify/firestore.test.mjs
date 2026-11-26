import { describe, expect, it } from "vitest";
import {
  hotCounter,
  hotIssue,
  indexStates,
  listQueries,
  payloadBoundary,
  ttlCheck,
  ttlPlant,
} from "./firestore.mjs";
import { dataOf, PROJECT, routerFetch, testContext } from "./testing.mjs";

const secret = [
  "GET",
  /secretmanager\.googleapis\.com/,
  () => ({
    body: {
      payload: { data: dataOf({ dsn: "https://k@ingest.test/7", token: "t" }) },
    },
  }),
];
const outputs = {
  ingest_url: "https://ingest.test",
  api_url: "https://api.test",
};

describe("firestore probe", () => {
  it("flags a list query that the database cannot serve", async () => {
    const make = (broken) =>
      routerFetch([
        secret,
        [
          "GET",
          /api\.test.*issues\/\?/,
          (url) => ({
            status:
              broken &&
              url.includes("sort=count") &&
              url.includes("status=resolved")
                ? 503
                : 200,
            body: [{ id: "1" }],
          }),
        ],
        ["GET", /api\.test.*events\//, () => ({ body: [] })],
      ]);
    const good = await testContext({ fetch: make(false), outputs });
    await listQueries(good.ctx);
    expect(good.output()).toContain(
      "PASS every issue and event list query is served",
    );
    const bad = await testContext({ fetch: make(true), outputs });
    await listQueries(bad.ctx);
    expect(bad.output()).toContain(
      "FAIL every issue and event list query is served (no missing index): resolved/count: 503",
    );
  });

  it("requires READY indexes", async () => {
    const fetch = (state) =>
      routerFetch([
        [
          "GET",
          /collectionGroups\/-\/indexes/,
          () => ({ body: { indexes: [{ state: "READY" }, { state }] } }),
        ],
      ]);
    const ready = await testContext({ fetch: fetch("READY") });
    await indexStates(ready.ctx);
    expect(ready.ctx.report.summary().fail).toBe(0);
    const building = await testContext({ fetch: fetch("CREATING") });
    await indexStates(building.ctx);
    expect(building.ctx.report.summary().fail).toBe(2);
  });

  it("stages a hot issue, waits for the exact count and reports dead letters", async () => {
    const run = (lossy) => {
      let polls = 0;
      let uploads = 0;
      let published = 0;
      const fetch = routerFetch([
        secret,
        [
          "POST",
          /storage\.googleapis\.com\/upload.*uploadType=media/,
          () => (uploads++, { body: {} }),
        ],
        [
          "POST",
          /:publish$/,
          (_url, init) => {
            published += JSON.parse(init.body).messages.length;
            return { body: { messageIds: [] } };
          },
        ],
        [
          "GET",
          /api\.test.*issues\//,
          () => {
            polls++;
            const hot = polls < 3 ? 5 : lossy ? 9 : 10;
            return {
              body: [
                { title: "g8 hot abc123", count: String(hot) },
                { title: "g8 background abc123", count: "2" },
              ],
            };
          },
        ],
        ["POST", /dlq:pull$/, () => ({ body: {} })],
      ]);
      return { fetch, counts: () => ({ uploads, published }) };
    };
    const good = run(false);
    const ok = await testContext({
      fetch: good.fetch,
      outputs,
      flags: { events: "10", background: "2", "drain-timeout": "30" },
    });
    await hotIssue(ok.ctx);
    expect(ok.ctx.report.summary().fail).toBe(0);
    expect(good.counts()).toEqual({ uploads: 12, published: 12 });
    const lossy = run(true);
    const bad = await testContext({
      fetch: lossy.fetch,
      outputs,
      flags: { events: "10", background: "2", "drain-timeout": "10" },
    });
    await hotIssue(bad.ctx);
    expect(bad.output()).toContain("FAIL hot issue count is exact");
    expect(bad.output()).toContain("hot 9/10");
  });

  it("detects a lost or doubled increment", async () => {
    const counter = (mutate) => {
      let value = 0;
      return async () => ({
        increment: async () => {
          value += 1;
          return mutate(value);
        },
        get: async () => String(value),
        delete: async () => {},
      });
    };
    const exact = await testContext({
      fetch: routerFetch([]),
      flags: { increments: "40" },
      deps: { createKv: counter((v) => v) },
    });
    await hotCounter(exact.ctx);
    expect(exact.output()).toContain("PASS concurrent increments");
    const doubled = await testContext({
      fetch: routerFetch([]),
      flags: { increments: "40" },
      deps: { createKv: counter((v) => Math.min(v, 5)) },
    });
    await hotCounter(doubled.ctx);
    expect(doubled.output()).toContain("FAIL concurrent increments");
  });

  it("checks the size boundary through ingest and the API", async () => {
    const sizes = new Map();
    const fetch = routerFetch([
      secret,
      [
        "POST",
        /ingest\.test\/api\/7\/envelope/,
        (_url, init) => {
          const body = String(init.body);
          if (Buffer.byteLength(body) > 1024 * 1024) return { status: 413 };
          const event = JSON.parse(body.split("\n")[2]);
          sizes.set(event.message, event.extra.large);
          return { body: {} };
        },
      ],
      [
        "GET",
        /api\.test.*issues\/\?/,
        () => ({
          body: [...sizes.keys()].map((title, index) => ({
            id: String(index),
            title,
            count: "1",
          })),
        }),
      ],
      [
        "GET",
        /api\.test\/api\/0\/issues\/(\d+)\/events\/latest\//,
        (_url, _init, match) => ({
          body: { extra: { large: [...sizes.values()][Number(match[1])] } },
        }),
      ],
    ]);
    const { ctx, output } = await testContext({ fetch, outputs });
    await payloadBoundary(ctx);
    expect(ctx.report.summary()).toMatchObject({ fail: 0, pass: 7 });
    expect(output()).not.toContain(PROJECT);
  });

  it("plants a TTL document and reports its deletion later", async () => {
    const states = new Map();
    let present = true;
    const fetch = routerFetch([
      ["PATCH", /documents\/kv\/g8-ttl-abc123$/, () => ({ body: {} })],
      [
        "GET",
        /documents\/kv\/g8-ttl-abc123$/,
        () => (present ? { body: {} } : { status: 404 }),
      ],
    ]);
    const deps = {
      writeState: async (_path, text) => states.set("state", text),
      readState: async () => states.get("state"),
    };
    const planted = await testContext({ fetch, deps });
    await ttlPlant(planted.ctx);
    const waiting = await testContext({ fetch, deps });
    await ttlCheck(waiting.ctx);
    expect(waiting.output()).toContain("SKIP TTL deletion");
    present = false;
    const done = await testContext({ fetch, deps });
    await ttlCheck(done.ctx);
    expect(done.output()).toContain("PASS TTL deleted the expired document");
    const none = await testContext({
      fetch,
      deps: {
        readState: async () => {
          throw new Error("none");
        },
      },
    });
    await ttlCheck(none.ctx);
    expect(none.output()).toContain("SKIP TTL deletion: no planted document");
  });
});
