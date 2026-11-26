import { describe, expect, it } from "vitest";
import {
  deadLetters,
  directCalls,
  inspectSubscriptions,
  pubsubSemantics,
  pushDelivers,
} from "./push.mjs";
import { dataOf, PROJECT, routerFetch, testContext } from "./testing.mjs";

const STACK = "gcp-g8";
const consumer = "https://consumer-hash.a.run.app";
const push = `projects/${PROJECT}/subscriptions/${STACK}-shared`;

function subscription(overrides = {}) {
  return {
    name: push,
    ackDeadlineSeconds: 180,
    pushConfig: {
      pushEndpoint: `${consumer}/_errtraq/push/shared`,
      oidcToken: {
        audience: "errtraq-push",
        serviceAccountEmail: `errtraq-push@${PROJECT}.iam.gserviceaccount.com`,
      },
    },
    deadLetterPolicy: {
      deadLetterTopic: `projects/${PROJECT}/topics/${STACK}-shared-dlq`,
      maxDeliveryAttempts: 5,
    },
    ...overrides,
  };
}
const service = [
  /run\.googleapis\.com\/v2\/.*services\/gcp-g8-consumer$/,
  () => ({ body: { uri: consumer } }),
];

describe("push probe", () => {
  it("accepts the designed subscription and flags a wrong audience", async () => {
    let current = subscription();
    const fetch = routerFetch([
      ["GET", service[0], service[1]],
      ["GET", /subscriptions\/gcp-g8-shared$/, () => ({ body: current })],
      ["GET", /subscriptions\/gcp-g8-record$/, () => ({ status: 404 })],
    ]);
    const first = await testContext({ fetch });
    await inspectSubscriptions(first.ctx);
    expect(first.ctx.report.summary().fail).toBe(0);
    expect(first.output()).toContain("SKIP record subscription");
    current = subscription({
      pushConfig: {
        ...current.pushConfig,
        oidcToken: {
          audience: "other",
          serviceAccountEmail: "x@y.iam.gserviceaccount.com",
        },
      },
    });
    const second = await testContext({ fetch });
    await inspectSubscriptions(second.ctx);
    expect(second.output()).toContain(
      "FAIL push carries an OIDC token with the configured audience",
    );
    expect(second.output()).not.toContain(PROJECT);
  });

  it("requires direct calls to be rejected, and checks the push account only on request", async () => {
    const statuses = [];
    const fetch = routerFetch([
      ["GET", service[0], service[1]],
      [
        "POST",
        /consumer-hash\.a\.run\.app\/_errtraq\/push\/shared$/,
        (_url, init) => {
          const token = init.headers.authorization ?? "";
          statuses.push(token);
          if (
            token ===
            `Bearer id-errtraq-push-${`errtraq-push@${PROJECT}.iam.gserviceaccount.com`}`
          )
            return { status: 400 };
          return { status: token ? 403 : 401 };
        },
      ],
    ]);
    const plain = await testContext({ fetch });
    await directCalls(plain.ctx);
    expect(plain.ctx.report.summary()).toMatchObject({ fail: 0, skip: 1 });
    expect(statuses[0]).toBe("");
    const impersonating = await testContext({
      fetch,
      flags: { "as-push-sa": true },
    });
    await directCalls(impersonating.ctx);
    expect(impersonating.ctx.report.summary()).toMatchObject({
      fail: 0,
      skip: 0,
    });
    // A consumer that accepts anyone must fail.
    const open = await testContext({
      fetch: routerFetch([
        ["GET", service[0], service[1]],
        ["POST", /push\/shared$/, () => ({ status: 204 })],
      ]),
    });
    await directCalls(open.ctx);
    expect(open.ctx.report.summary().fail).toBe(3);
  });

  it("waits for the event to arrive through the push", async () => {
    let polls = 0;
    const fetch = routerFetch([
      [
        "GET",
        /secretmanager\.googleapis\.com/,
        () => ({
          body: {
            payload: {
              data: dataOf({ dsn: "https://k@ingest.test/7", token: "t" }),
            },
          },
        }),
      ],
      ["POST", /ingest\.test\/api\/7\/envelope/, () => ({ body: {} })],
      [
        "GET",
        /api\.test\/api\/0\/projects/,
        () => ({
          body: ++polls < 3 ? [] : [{ title: "g8 push abc123", count: "1" }],
        }),
      ],
    ]);
    const { ctx, output } = await testContext({
      fetch,
      outputs: {
        ingest_url: "https://ingest.test",
        api_url: "https://api.test",
      },
    });
    await pushDelivers(ctx);
    expect(polls).toBe(3);
    expect(output()).toContain(
      "PASS the OIDC push delivered the event to the consumer",
    );
  });

  function deadLetterWorld({ acknowledgeMissing }) {
    const published = [];
    let pulls = 0;
    const fetch = routerFetch([
      [
        "GET",
        /secretmanager\.googleapis\.com/,
        () => ({
          body: {
            payload: {
              data: dataOf({ dsn: "https://k@ingest.test/7", token: "t" }),
            },
          },
        }),
      ],
      [
        "POST",
        /pubsub\.googleapis\.com\/v1\/projects\/.*-shared:publish$/,
        (_url, init) => {
          published.push(...JSON.parse(init.body).messages);
          return { body: { messageIds: ["1", "2"] } };
        },
      ],
      [
        "POST",
        /subscriptions\/gcp-g8-shared-dlq:pull$/,
        () => {
          pulls++;
          if (pulls < 3) return { body: {} };
          const messages = [
            {
              ackId: "a1",
              message: {
                data: published[0].data,
                attributes: {
                  CloudPubSubDeadLetterSourceDeliveryCount: "5",
                  CloudPubSubDeadLetterSourceSubscription: "x",
                },
              },
            },
          ];
          if (!acknowledgeMissing)
            messages.push({
              ackId: "a2",
              message: { data: published[1].data, attributes: {} },
            });
          return { body: { receivedMessages: pulls === 3 ? messages : [] } };
        },
      ],
      ["POST", /subscriptions\/gcp-g8-record-dlq:pull$/, () => ({ body: {} })],
      ["POST", /:acknowledge$/, () => ({ body: {} })],
    ]);
    return { fetch };
  }
  it("distinguishes a delivered attempt count from a missing one", async () => {
    const good = await testContext({
      fetch: deadLetterWorld({ acknowledgeMissing: true }).fetch,
      flags: { "dlq-grace": "0" },
    });
    await deadLetters(good.ctx);
    expect(good.ctx.report.summary().fail).toBe(0);
    expect(good.output()).toContain("PASS deliveryAttempt reaches the handler");
    const bad = await testContext({
      fetch: deadLetterWorld({ acknowledgeMissing: false }).fetch,
      flags: { "dlq-grace": "0" },
    });
    await deadLetters(bad.ctx);
    expect(bad.output()).toContain("FAIL deliveryAttempt reaches the handler");
  });

  it("checks ack deadline limits and nack ordering, and deletes the probe resources", async () => {
    const deleted = [];
    let queue = [];
    let delivered = 0;
    const fetch = routerFetch([
      ["PUT", /topics\/gcp-g8-g8probe-abc123$/, () => ({ body: {} })],
      [
        "PUT",
        /subscriptions\/gcp-g8-g8probe-abc123-limit$/,
        (_url, init) => ({
          status: JSON.parse(init.body).ackDeadlineSeconds > 600 ? 400 : 200,
          body: { error: { status: "INVALID_ARGUMENT" } },
        }),
      ],
      ["PUT", /subscriptions\/gcp-g8-g8probe-abc123$/, () => ({ body: {} })],
      [
        "POST",
        /europe-west1-pubsub\.googleapis\.com.*:publish$/,
        (_url, init) => {
          queue = JSON.parse(init.body).messages.map((message) => message.data);
          return { body: { messageIds: queue.map(String) } };
        },
      ],
      [
        "POST",
        /\/\/pubsub\.googleapis\.com.*:publish$/,
        () => ({ body: { messageIds: ["9"] } }),
      ],
      [
        "POST",
        /:pull$/,
        () => {
          const data = queue[0];
          delivered++;
          return {
            body: {
              receivedMessages: [
                { ackId: `ack${delivered}`, message: { data } },
              ],
            },
          };
        },
      ],
      ["POST", /:modifyAckDeadline$/, () => ({ body: {} })],
      [
        "POST",
        /:acknowledge$/,
        () => {
          queue = queue.slice(1);
          return { body: {} };
        },
      ],
      [
        "DELETE",
        /./,
        (url) => {
          deleted.push(url);
          return { body: {} };
        },
      ],
    ]);
    const { ctx, output } = await testContext({ fetch });
    await pubsubSemantics(ctx);
    expect(ctx.report.summary().fail).toBe(0);
    expect(output()).toContain(
      "PASS then the next message of the key follows in order",
    );
    expect(deleted.length).toBe(2);
    expect(deleted[1]).toMatch(/topics\//);
  });
});
