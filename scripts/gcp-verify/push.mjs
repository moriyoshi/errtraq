import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { b64, errorStatus, main, ok } from "./lib.mjs";
import { buildEnvelope } from "./sdk-e2e.mjs";

/**
 * Pub/Sub push on a real project: the subscription configuration, rejection of unauthenticated and
 * wrong-audience calls sent straight to the consumer, an event reaching the consumer through the
 * OIDC push, dead-letter delivery after a poison message, `deliveryAttempt` (observed through the
 * consumer's missing-claim rule, which acknowledges on attempt 5 only when the attempt count
 * arrives), the 600 s ack deadline maximum, and redelivery order after a nack on an ordered
 * subscription (probe topic, deleted afterwards).
 */
export const probe = {
  name: "push",
  description:
    "OIDC push, direct calls rejected, dead letters, deliveryAttempt, ack deadline, ordering",
  run,
};

const PUBSUB = "https://pubsub.googleapis.com/v1";
const TOPIC_ATTRIBUTE = "errtraq-topic";
const REJECTED = [401, 403, 404];

const regional = (ctx) =>
  `https://${ctx.config.region}-pubsub.googleapis.com/v1`;
const decode = (message) =>
  Buffer.from(message.data ?? "", "base64").toString("utf8");

async function pull(ctx, subscription, max = 10) {
  const response = await ctx.http("POST", `${PUBSUB}/${subscription}:pull`, {
    json: { maxMessages: max, returnImmediately: true },
  });
  return ok(response) ? (response.json?.receivedMessages ?? []) : [];
}
const acknowledge = (ctx, subscription, ackIds) =>
  ackIds.length
    ? ctx.http("POST", `${PUBSUB}/${subscription}:acknowledge`, {
        json: { ackIds },
      })
    : undefined;

/** The subscription configuration the platform module is meant to create. */
export async function inspectSubscriptions(ctx) {
  const { report } = ctx;
  const consumer = await ctx.service("consumer");
  const shared = await ctx.http(
    "GET",
    `${PUBSUB}/${ctx.names.subscription("shared")}`,
  );
  if (!ok(shared))
    return report.fail(
      "shared push subscription exists",
      `status ${shared.status}`,
    );
  const push = shared.json.pushConfig ?? {};
  report.check(
    "push endpoint targets the consumer service",
    String(push.pushEndpoint ?? "") === `${consumer.uri}/_errtraq/push/shared`,
    "endpoint differs from the consumer URL",
  );
  report.check(
    "push carries an OIDC token with the configured audience",
    push.oidcToken?.audience === ctx.config.audience,
    () => `audience ${push.oidcToken?.audience ?? "none"}`,
  );
  report.check(
    "push identity is the dedicated push service account",
    push.oidcToken?.serviceAccountEmail === ctx.names.pushServiceAccount,
    () => `identity ${push.oidcToken?.serviceAccountEmail ?? "none"}`,
  );
  report.check(
    "dead-letter policy points at the dead-letter topic",
    shared.json.deadLetterPolicy?.deadLetterTopic ===
      ctx.names.dlqTopic("shared") &&
      shared.json.deadLetterPolicy?.maxDeliveryAttempts >= 5,
    () =>
      `max attempts ${shared.json.deadLetterPolicy?.maxDeliveryAttempts ?? "none"}`,
  );
  report.info(
    "ack deadline",
    `${shared.json.ackDeadlineSeconds} s; retry ${JSON.stringify(shared.json.retryPolicy ?? {})}`,
  );
  const record = await ctx.http(
    "GET",
    `${PUBSUB}/${ctx.names.subscription("record")}`,
  );
  if (ok(record))
    report.check(
      "record subscription is ordered",
      record.json.enableMessageOrdering === true &&
        record.json.pushConfig?.oidcToken?.audience === ctx.config.audience,
      "ordering or audience wrong",
    );
  else report.skip("record subscription", "the stack has no record queue");
  return shared.json;
}

/** Calls sent straight to the consumer: only the push account may invoke it. */
export async function directCalls(ctx) {
  const { report } = ctx;
  const consumer = await ctx.service("consumer");
  const target = `${consumer.uri}/_errtraq/push/shared`;
  const post = (token) =>
    ctx.http("POST", target, {
      token,
      body: "{}",
      headers: { "content-type": "application/json" },
    });
  const none = await post("none");
  report.check(
    "a push without a token is rejected",
    REJECTED.includes(none.status),
    `status ${none.status}`,
  );
  const wrong = await post(await ctx.auth.idToken("g8-wrong-audience"));
  report.check(
    "a push with a wrong audience is rejected",
    REJECTED.includes(wrong.status),
    `status ${wrong.status}`,
  );
  const operator = await post(await ctx.auth.idToken(ctx.config.audience));
  report.check(
    "a caller other than the push account is rejected",
    REJECTED.includes(operator.status),
    `status ${operator.status}`,
  );
  if (!ctx.flags["as-push-sa"]) {
    report.skip(
      "handler-level verification as the push account",
      "pass --as-push-sa (needs roles/iam.serviceAccountTokenCreator on the push account)",
    );
    return;
  }
  const good = await post(
    await ctx.auth.idToken(ctx.config.audience, {
      as: ctx.names.pushServiceAccount,
    }),
  );
  report.check(
    "the push account reaches the handler (an invalid body is a 400)",
    good.status === 400,
    `status ${good.status}`,
  );
  const badAudience = await post(
    await ctx.auth.idToken("g8-wrong-audience", {
      as: ctx.names.pushServiceAccount,
    }),
  );
  report.check(
    "the push account with a wrong audience is rejected",
    REJECTED.includes(badAudience.status),
    `status ${badAudience.status}`,
  );
  const scheduler = await post(
    await ctx.auth.idToken(ctx.config.audience, {
      as: ctx.names.schedulerServiceAccount,
    }),
  );
  report.check(
    "the scheduler account cannot push",
    REJECTED.includes(scheduler.status),
    `status ${scheduler.status}`,
  );
}

/** An event sent through ingest reaches the consumer through the real OIDC push. */
export async function pushDelivers(ctx) {
  const { report } = ctx;
  const boot = await ctx.bootstrap();
  const ingest = await ctx.url("ingest");
  const api = await ctx.url("api");
  const text = `g8 push ${ctx.config.runId}`;
  const sent = await ctx.http(
    "POST",
    `${ingest}/api/${boot.projectId}/envelope/?sentry_key=${boot.publicKey}`,
    {
      token: "none",
      body: buildEnvelope(randomBytes(16).toString("hex"), text),
    },
  );
  report.check(
    "ingest accepts the envelope",
    ok(sent),
    `status ${sent.status}`,
  );
  const started = ctx.clock.now();
  let issue;
  try {
    issue = await ctx.poll(
      "event recorded",
      async () =>
        (
          await ctx.http(
            "GET",
            `${api}/api/0/projects/${ctx.config.org}/${ctx.config.projectSlug}/issues/?limit=100`,
            { token: boot.token },
          )
        ).json?.find((item) => String(item.title).includes(text)),
      { timeoutMs: 180_000, intervalMs: 2000 },
    );
  } catch {
    issue = undefined;
  }
  report.check(
    "the OIDC push delivered the event to the consumer",
    issue?.count === "1",
    () => `after ${Math.round((ctx.clock.now() - started) / 1000)} s`,
  );
}

/** Poison message to the dead-letter topic, and deliveryAttempt through the missing-claim rule. */
export async function deadLetters(ctx) {
  const { report } = ctx;
  const boot = await ctx.bootstrap();
  const marker = `g8-poison-${ctx.config.runId}`;
  const topic = ctx.names.topic("shared");
  const eventId = randomBytes(16).toString("hex");
  const missing = {
    key: eventId,
    body: {
      projectId: boot.projectId,
      blobKey: `envelopes/${boot.projectId}/${encodeURIComponent(new Date().toISOString())}/${eventId}/g8-missing-${ctx.config.runId}`,
      receivedAt: new Date().toISOString(),
    },
  };
  const published = await ctx.http("POST", `${PUBSUB}/${topic}:publish`, {
    json: {
      messages: [
        { data: b64(marker), attributes: { [TOPIC_ATTRIBUTE]: "ingest" } },
        {
          data: b64(JSON.stringify(missing)),
          attributes: { [TOPIC_ATTRIBUTE]: "ingest", "errtraq-key": eventId },
        },
      ],
    },
  });
  if (
    !report.check(
      "poison and missing-claim messages published",
      ok(published) && published.json?.messageIds?.length === 2,
      `status ${published.status}`,
    )
  )
    return;
  const dlq = ctx.names.dlqSubscription("shared");
  const timeoutMs = Number(ctx.flags["dlq-timeout"] ?? 900) * 1000;
  const started = ctx.clock.now();
  let dead;
  let found = [];
  try {
    dead = await ctx.poll(
      "dead letter",
      async () => {
        const messages = await pull(ctx, dlq);
        found = found.concat(messages);
        return found.find((item) => decode(item.message) === marker);
      },
      { timeoutMs, intervalMs: 5000 },
    );
  } catch {
    dead = undefined;
  }
  if (
    !report.check(
      "a poison message reaches the dead-letter subscription",
      dead !== undefined,
      () => `after ${Math.round((ctx.clock.now() - started) / 1000)} s`,
    )
  )
    return;
  const attributes = dead.message.attributes ?? {};
  const attempts = Number(
    attributes.CloudPubSubDeadLetterSourceDeliveryCount ?? 0,
  );
  report.check(
    "the dead letter carries the source subscription and delivery count",
    attempts >= 5 &&
      String(attributes.CloudPubSubDeadLetterSourceSubscription ?? "") !== "",
    `delivery count ${attempts}`,
  );
  // Give the missing-claim message the same chance to be dead-lettered if no attempt count ever arrives.
  await ctx.clock.sleep(Number(ctx.flags["dlq-grace"] ?? 60) * 1000);
  found = found.concat(await pull(ctx, dlq));
  const stray = found.some((item) =>
    decode(item.message).includes(`g8-missing-${ctx.config.runId}`),
  );
  report.check(
    "deliveryAttempt reaches the handler (the missing-claim message was acknowledged on attempt 5, not dead-lettered)",
    !stray,
    "the message was dead-lettered, so the attempt count never arrived",
  );
  await acknowledge(
    ctx,
    dlq,
    found
      .filter(
        (item) =>
          decode(item.message) === marker ||
          decode(item.message).includes(`g8-missing-${ctx.config.runId}`),
      )
      .map((item) => item.ackId),
  );
  const record = await pull(ctx, ctx.names.dlqSubscription("record"), 5);
  if (record.length)
    report.fail(
      "the record dead-letter subscription is empty",
      `${record.length} message(s)`,
    );
  else
    report.pass(
      "the record dead-letter subscription is empty (or the stack has no record queue)",
    );
}

/** Behaviour of Pub/Sub itself on a throwaway ordered topic: ack deadline limits, order after a nack, regional publish. */
export async function pubsubSemantics(ctx) {
  const { report } = ctx;
  const id = `${ctx.config.stack}-g8probe-${ctx.config.runId}`;
  const topic = `projects/${ctx.config.project}/topics/${id}`;
  const subscription = `projects/${ctx.config.project}/subscriptions/${id}`;
  const second = `${subscription}-limit`;
  const created = [];
  try {
    const topicResponse = await ctx.http("PUT", `${PUBSUB}/${topic}`, {
      json: { labels: { app: "errtraq" } },
    });
    if (
      !report.check(
        "probe topic created",
        ok(topicResponse),
        `status ${topicResponse.status}`,
      )
    )
      return;
    created.push(topic);
    const maximum = await ctx.http("PUT", `${PUBSUB}/${subscription}`, {
      json: {
        topic,
        ackDeadlineSeconds: 600,
        enableMessageOrdering: true,
        expirationPolicy: { ttl: "86400s" },
      },
    });
    report.check(
      "an ack deadline of 600 s is accepted (queue capability maxVisibilityTimeoutSec)",
      ok(maximum),
      `status ${maximum.status}`,
    );
    if (ok(maximum)) created.push(subscription);
    const over = await ctx.http("PUT", `${PUBSUB}/${second}`, {
      json: {
        topic,
        ackDeadlineSeconds: 601,
        expirationPolicy: { ttl: "86400s" },
      },
    });
    report.check(
      "an ack deadline of 601 s is rejected",
      over.status === 400,
      `status ${over.status} ${errorStatus(over)}`,
    );
    if (ok(over)) created.push(second);
    if (!ok(maximum)) return;
    const publishOrdered = (base, payloads) =>
      ctx.http("POST", `${base}/${topic}:publish`, {
        json: {
          messages: payloads.map((data) => ({
            data: b64(data),
            orderingKey: "g8-key",
          })),
        },
      });
    const viaRegion = await publishOrdered(regional(ctx), ["m1", "m2", "m3"]);
    report.check(
      "ordered publish through the regional endpoint succeeds",
      ok(viaRegion),
      `status ${viaRegion.status}`,
    );
    const viaGlobal = await publishOrdered(PUBSUB, ["g1"]);
    report.info(
      "ordered publish through the global endpoint",
      `status ${viaGlobal.status} ${errorStatus(viaGlobal)}`,
    );
    const next = async () => {
      const [message] = await ctx.poll(
        "pull",
        async () => {
          const messages = await pull(ctx, subscription, 1);
          return messages.length ? messages : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 1500 },
      );
      return message;
    };
    const first = await next();
    await ctx.http("POST", `${PUBSUB}/${subscription}:modifyAckDeadline`, {
      json: { ackIds: [first.ackId], ackDeadlineSeconds: 0 },
    });
    const again = await next();
    report.check(
      "after a nack the same message is redelivered before later ones of its key",
      decode(first.message) === "m1" && decode(again.message) === "m1",
      () => `got ${decode(first.message)} then ${decode(again.message)}`,
    );
    await acknowledge(ctx, subscription, [again.ackId]);
    const following = await next();
    report.check(
      "then the next message of the key follows in order",
      decode(following.message) === "m2",
      () => `got ${decode(following.message)}`,
    );
    report.info(
      "push body fields",
      "orderingKey and deliveryAttempt presence in a push body are not observable from outside; see the deliveryAttempt check",
    );
  } finally {
    // Subscriptions first (created last), then the topic.
    for (const resource of created.reverse())
      await ctx.http("DELETE", `${PUBSUB}/${resource}`, { raw: true });
  }
}

async function run(ctx) {
  const selected = String(
    ctx.flags.only ?? "inspect,direct,delivers,semantics,deadletters",
  ).split(",");
  const steps = {
    inspect: inspectSubscriptions,
    direct: directCalls,
    delivers: pushDelivers,
    semantics: pubsubSemantics,
    deadletters: deadLetters,
  };
  for (const name of selected) if (steps[name]) await steps[name](ctx);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main([probe]));
