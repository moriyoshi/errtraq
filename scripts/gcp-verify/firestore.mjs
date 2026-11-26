import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { b64, main, ok, pool } from "./lib.mjs";
import { buildEnvelope } from "./sdk-e2e.mjs";

/**
 * Firestore on a real project: the index set serves every API list query, a hot issue and a hot
 * DSN-key counter stay exact under concurrency, payloads at the 1 MiB boundary overflow to GCS
 * (and one byte over the limit is refused), indexes are READY, and TTL deletion lag (planted now,
 * checked later with `--only ttl-check`).
 */
export const probe = {
  name: "firestore",
  description:
    "list queries and indexes, hot issue, hot KV counter, 1 MiB boundary, TTL lag",
  run,
};

const PUBSUB = "https://pubsub.googleapis.com/v1";
const STATUSES = [undefined, "unresolved", "resolved", "ignored"];
const SORTS = ["lastSeen", "firstSeen", "count"];
const ENVELOPE_LIMIT = 1024 * 1024;

const issuesPath = (ctx) =>
  `/api/0/projects/${ctx.config.org}/${ctx.config.projectSlug}/issues/`;
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
    : 0;
};

async function apiGet(ctx, path) {
  const boot = await ctx.bootstrap();
  return ctx.http("GET", `${await ctx.url("api")}${path}`, {
    token: boot.token,
  });
}
async function findIssue(ctx, text, timeoutMs = 120_000) {
  try {
    return await ctx.poll(
      `issue ${text}`,
      async () =>
        (await apiGet(ctx, `${issuesPath(ctx)}?limit=100`)).json?.find((item) =>
          String(item.title).includes(text),
        ),
      { timeoutMs, intervalMs: 2000 },
    );
  } catch {
    return undefined;
  }
}

/** Every sort and status filter the API serves, with paging, must succeed (a missing index would be a 5xx). */
export async function listQueries(ctx) {
  const failures = [];
  let pages = 0;
  for (const status of STATUSES)
    for (const sort of SORTS) {
      let cursor = "";
      for (let page = 0; page < 3; page++) {
        const query = new URLSearchParams({
          limit: "2",
          sort,
          ...(status ? { status } : {}),
          ...(cursor ? { cursor } : {}),
        });
        const response = await apiGet(ctx, `${issuesPath(ctx)}?${query}`);
        pages++;
        if (response.status !== 200) {
          failures.push(`${status ?? "any"}/${sort}: ${response.status}`);
          break;
        }
        cursor =
          response.headers
            .get("link")
            ?.match(/rel="next"; results="true"; cursor="([^"]+)"/)?.[1] ?? "";
        if (!cursor) break;
      }
    }
  const first = (await apiGet(ctx, `${issuesPath(ctx)}?limit=1`)).json?.[0];
  if (first) {
    const events = await apiGet(
      ctx,
      `/api/0/issues/${first.id}/events/?limit=2`,
    );
    pages++;
    if (events.status !== 200) failures.push(`events: ${events.status}`);
  }
  ctx.report.check(
    "every issue and event list query is served (no missing index)",
    failures.length === 0,
    () => failures.join(", "),
  );
  ctx.report.info("list queries", `${pages} requests`);
}

/** Composite indexes of both databases must be READY, and the kv TTL policy ACTIVE next to its field exemption. */
export async function indexStates(ctx) {
  for (const purpose of ["store", "kv"]) {
    const response = await ctx.http(
      "GET",
      `https://firestore.googleapis.com/v1/${ctx.names.database(purpose)}/collectionGroups/-/indexes`,
    );
    const indexes = response.json?.indexes ?? [];
    const notReady = indexes.filter((item) => item.state !== "READY");
    ctx.report.check(
      `${purpose} database indexes are READY`,
      ok(response) &&
        (purpose === "kv" || indexes.length > 0) &&
        notReady.length === 0,
      () =>
        `${indexes.length} indexes, ${notReady.length} not ready (${response.status})`,
    );
  }
  const field = await ctx.http(
    "GET",
    `https://firestore.googleapis.com/v1/${ctx.names.database("kv")}/collectionGroups/kv/fields/expireAt`,
  );
  ctx.report.check(
    "the kv expireAt field has an ACTIVE TTL policy and no index (exemption merged)",
    field.json?.ttlConfig?.state === "ACTIVE" &&
      !(field.json?.indexConfig?.indexes ?? []).length,
    () => `ttl ${field.json?.ttlConfig?.state ?? "none"} (${field.status})`,
  );
}

async function stage(ctx, boot, message, index) {
  const eventId = randomBytes(16).toString("hex");
  const receivedAt = new Date().toISOString();
  const blobKey = `envelopes/${boot.projectId}/${encodeURIComponent(receivedAt)}/${eventId}/g8hot-${ctx.config.runId}-${index}`;
  const upload = await ctx.http(
    "POST",
    `https://storage.googleapis.com/upload/storage/v1/b/${ctx.names.bucket}/o?uploadType=media&name=${encodeURIComponent(blobKey)}`,
    {
      body: buildEnvelope(eventId, message),
      headers: { "content-type": "application/octet-stream" },
    },
  );
  if (!ok(upload)) return { ok: false, status: upload.status };
  const payload = {
    key: eventId,
    body: { projectId: boot.projectId, blobKey, receivedAt },
  };
  return { eventId, payload, blobKey };
}

/** Hot issue and a background issue staged straight onto the queue (bypassing the ingest rate limit). */
export async function hotIssue(ctx) {
  const { report } = ctx;
  const boot = await ctx.bootstrap();
  const hot = Number(ctx.flags.events ?? 200);
  const background = Number(ctx.flags.background ?? 20);
  const concurrency = Number(ctx.flags.concurrency ?? 32);
  const hotText = `g8 hot ${ctx.config.runId}`;
  const backgroundText = `g8 background ${ctx.config.runId}`;
  const plan = [
    ...Array.from({ length: hot }, (_, i) => [hotText, i]),
    ...Array.from({ length: background }, (_, i) => [backgroundText, hot + i]),
  ];
  const started = ctx.clock.now();
  const staged = await pool(plan, concurrency, ([text, index]) =>
    stage(ctx, boot, text, index),
  );
  const stagedOk = staged.filter((item) => item.payload);
  report.check(
    "envelopes staged to GCS",
    stagedOk.length === plan.length,
    `${stagedOk.length} of ${plan.length}`,
  );
  const batches = [];
  for (let i = 0; i < stagedOk.length; i += 10)
    batches.push(stagedOk.slice(i, i + 10));
  const published = await pool(batches, concurrency, (batch) =>
    ctx.http("POST", `${PUBSUB}/${ctx.names.topic("shared")}:publish`, {
      json: {
        messages: batch.map((item) => ({
          data: b64(JSON.stringify(item.payload)),
          attributes: {
            "errtraq-topic": "ingest",
            "errtraq-key": item.eventId,
          },
        })),
      },
    }),
  );
  report.check(
    "messages published",
    published.every(ok),
    `${published.filter(ok).length} of ${batches.length} batches`,
  );
  const sentAt = ctx.clock.now();
  const expected = new Map([
    [hotText, hot],
    [backgroundText, background],
  ]);
  let counts = new Map();
  try {
    await ctx.poll(
      "issue counts",
      async () => {
        const rows =
          (await apiGet(ctx, `${issuesPath(ctx)}?limit=100`)).json ?? [];
        counts = new Map(
          [...expected.keys()].map((text) => [
            text,
            Number(
              rows.find((row) => String(row.title).includes(text))?.count ?? 0,
            ),
          ]),
        );
        return [...expected].every(
          ([text, count]) => counts.get(text) === count,
        );
      },
      {
        timeoutMs: Number(ctx.flags["drain-timeout"] ?? 300) * 1000,
        intervalMs: 2000,
      },
    );
  } catch {
    // The check below reports the observed counts.
  }
  const drained = Math.round((ctx.clock.now() - sentAt) / 1000);
  report.check(
    "hot issue count is exact after redeliveries (no lost or doubled event)",
    counts.get(hotText) === hot && counts.get(backgroundText) === background,
    () =>
      `hot ${counts.get(hotText) ?? 0}/${hot}, background ${counts.get(backgroundText) ?? 0}/${background}`,
  );
  report.info(
    "hot issue timing",
    `staged in ${Math.round((sentAt - started) / 1000)} s, drained ${drained} s after the last publish`,
  );
  // No dead letters from this run (a peek: the pulled messages are not acknowledged).
  const dlq = await ctx.http(
    "POST",
    `${PUBSUB}/${ctx.names.dlqSubscription("shared")}:pull`,
    { json: { maxMessages: 100, returnImmediately: true } },
  );
  const dead = (dlq.json?.receivedMessages ?? []).filter((item) =>
    Buffer.from(item.message?.data ?? "", "base64")
      .toString()
      .includes(`g8hot-${ctx.config.runId}`),
  );
  report.check(
    "no event of this run was dead-lettered",
    dead.length === 0,
    `${dead.length} dead letter(s)`,
  );
}

export async function realKv(ctx) {
  const { create } = await import("@moriyoshi/errtraq-kv-firestore/runtime");
  const emulator = ctx.env.FIRESTORE_EMULATOR_HOST;
  return create({
    config: { projectId: ctx.config.project, location: ctx.config.region },
    bindings: {
      ERRTRAQ_KV_DATABASE: emulator ? "(default)" : ctx.names.databaseId("kv"),
      accessToken: () => ctx.auth.accessToken(),
    },
    environment: emulator ? { FIRESTORE_EMULATOR_HOST: emulator } : {},
  });
}

/** Concurrent increments of one counter (the shape of the DSN-key rate limiter): exact and unique. */
export async function hotCounter(ctx) {
  const { report } = ctx;
  const kv = await (ctx.deps.createKv ?? realKv)(ctx);
  const total = Number(ctx.flags.increments ?? 200);
  const key = `g8probe/${ctx.config.runId}/hot`;
  const latencies = [];
  let errors = 0;
  const returned = [];
  try {
    await pool(
      Array.from({ length: total }),
      Number(ctx.flags["kv-concurrency"] ?? 50),
      async () => {
        const started = ctx.clock.now();
        try {
          returned.push(await kv.increment(key, 1, { ttlSec: 3600 }));
        } catch {
          errors++;
        }
        latencies.push(ctx.clock.now() - started);
      },
    );
    const final = Number(await kv.get(key));
    const unique = new Set(returned).size === returned.length;
    report.check(
      "concurrent increments of one key are exact and atomic",
      final === returned.length && unique,
      () =>
        `final ${final}, applied ${returned.length}, duplicates ${returned.length - new Set(returned).size}`,
    );
    report.info(
      "hot counter",
      `${total} increments, ${errors} failed after adapter retries, p50 ${percentile(latencies, 50)} ms, p95 ${percentile(latencies, 95)} ms, max ${Math.max(0, ...latencies)} ms`,
    );
  } finally {
    await kv.delete(key).catch(() => undefined);
  }
}

/** An envelope just under the 1 MiB limit is recorded in full through overflow; one byte over is refused. */
export async function payloadBoundary(ctx) {
  const { report } = ctx;
  const boot = await ctx.bootstrap();
  const ingest = await ctx.url("ingest");
  const url = `${ingest}/api/${boot.projectId}/envelope/?sentry_key=${boot.publicKey}`;
  const make = (text, size) =>
    buildEnvelope(randomBytes(16).toString("hex"), text).replace(
      /"level":"error"/,
      `"extra":{"large":"${"x".repeat(size)}"},"level":"error"`,
    );
  const cases = [
    ["inline", 150_000],
    ["overflow", 600_000],
    ["near the limit", ENVELOPE_LIMIT - 4096],
  ];
  for (const [label, size] of cases) {
    const text = `g8 size ${label} ${ctx.config.runId}`;
    const body = make(text, size);
    const sent = await ctx.http("POST", url, { token: "none", body });
    if (
      !report.check(
        `${label} payload (${Buffer.byteLength(body)} bytes) accepted`,
        ok(sent),
        `status ${sent.status}`,
      )
    )
      continue;
    const issue = await findIssue(ctx, text);
    const latest = issue
      ? await apiGet(ctx, `/api/0/issues/${issue.id}/events/latest/`)
      : undefined;
    report.check(
      `${label} payload is stored and read back intact`,
      latest?.json?.extra?.large?.length === size,
      () =>
        `read ${latest?.json?.extra?.large?.length ?? "nothing"} of ${size}`,
    );
  }
  const over = await ctx.http("POST", url, {
    token: "none",
    body: make(`g8 size over ${ctx.config.runId}`, ENVELOPE_LIMIT),
  });
  report.check(
    "an envelope over 1 MiB is refused",
    over.status === 413,
    `status ${over.status}`,
  );
}

const statePath = (ctx) => resolve(ctx.config.stateDir, "g8-ttl.json");

/** Plant a document whose TTL field is already in the past; `ttl-check` reports when it disappears. */
export async function ttlPlant(ctx) {
  const key = `g8-ttl-${ctx.config.runId}`;
  const expireAt = new Date(ctx.clock.now() - 60_000).toISOString();
  const response = await ctx.http(
    "PATCH",
    `https://firestore.googleapis.com/v1/${ctx.names.database("kv")}/documents/kv/${key}`,
    {
      json: {
        fields: {
          v: { stringValue: "x" },
          expireAt: { timestampValue: expireAt },
        },
      },
    },
  );
  if (
    !ctx.report.check(
      "TTL document planted",
      ok(response),
      `status ${response.status}`,
    )
  )
    return;
  const write =
    ctx.deps.writeState ??
    (async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    });
  await write(statePath(ctx), JSON.stringify({ key, expireAt }));
  ctx.report.info(
    "TTL",
    "run `--only ttl-check` later; TTL deletion is best effort and can take up to a day",
  );
}
export async function ttlCheck(ctx) {
  const read = ctx.deps.readState ?? ((path) => readFile(path, "utf8"));
  let planted;
  try {
    planted = JSON.parse(await read(statePath(ctx)));
  } catch {
    return ctx.report.skip(
      "TTL deletion",
      "no planted document (run ttl-plant first)",
    );
  }
  const response = await ctx.http(
    "GET",
    `https://firestore.googleapis.com/v1/${ctx.names.database("kv")}/documents/kv/${planted.key}`,
  );
  const lagMinutes = Math.round(
    (ctx.clock.now() - Date.parse(planted.expireAt)) / 60_000,
  );
  if (response.status === 404)
    ctx.report.pass(
      "TTL deleted the expired document",
      `lag at most ${lagMinutes} min`,
    );
  else if (ok(response))
    ctx.report.skip(
      "TTL deletion",
      `the document still exists ${lagMinutes} min after expiry; check again later`,
    );
  else ctx.report.fail("TTL deletion", `status ${response.status}`);
}

async function run(ctx) {
  const steps = {
    indexes: indexStates,
    queries: listQueries,
    hot: hotIssue,
    counter: hotCounter,
    payload: payloadBoundary,
    "ttl-plant": ttlPlant,
    "ttl-check": ttlCheck,
  };
  const selected = String(
    ctx.flags.only ?? "indexes,queries,hot,counter,payload,ttl-plant",
  ).split(",");
  for (const name of selected) if (steps[name]) await steps[name](ctx);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main([probe]));
