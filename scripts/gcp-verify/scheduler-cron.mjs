import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { main, ok } from "./lib.mjs";
import { buildEnvelope } from "./sdk-e2e.mjs";

/**
 * Cloud Scheduler to the cron service: job configuration (schedule, OIDC audience and account),
 * the cron route closed to unauthenticated callers, and recovery of a planted stale envelope (no
 * queue message) by a cron run, forced with `:run` or awaited with `--natural` (the AWS recovery
 * check).
 */
export const probe = {
  name: "cron",
  description:
    "Scheduler job configuration, staged-envelope recovery by a cron run",
  run,
};

const SCHEDULER = "https://cloudscheduler.googleapis.com/v1";
const JOBS = {
  "staged-recovery": "*/5 * * * *",
  "bundle-cleanup": "*/15 * * * *",
};

export async function jobConfiguration(ctx) {
  const cron = await ctx.service("cron");
  for (const [name, schedule] of Object.entries(JOBS)) {
    const response = await ctx.http(
      "GET",
      `${SCHEDULER}/${ctx.names.job(name)}`,
    );
    if (
      !ctx.report.check(
        `scheduler job ${name} exists`,
        ok(response),
        `status ${response.status}`,
      )
    )
      continue;
    const job = response.json;
    const target = job.httpTarget ?? {};
    ctx.report.check(
      `scheduler job ${name} is enabled with the designed schedule and identity`,
      job.state === "ENABLED" &&
        job.schedule === schedule &&
        target.oidcToken?.audience === ctx.config.audience &&
        target.oidcToken?.serviceAccountEmail ===
          ctx.names.schedulerServiceAccount &&
        target.uri === `${cron.uri}/_errtraq/cron/${name}` &&
        target.httpMethod === "POST",
      () => `state ${job.state}, schedule ${job.schedule}`,
    );
  }
  const anonymous = await ctx.http(
    "POST",
    `${cron.uri}/_errtraq/cron/staged-recovery`,
    { token: "none" },
  );
  ctx.report.check(
    "the cron route rejects an unauthenticated call",
    [401, 403, 404].includes(anonymous.status),
    `status ${anonymous.status}`,
  );
}

export async function recovery(ctx) {
  const { report } = ctx;
  const boot = await ctx.bootstrap();
  const api = await ctx.url("api");
  const eventId = randomBytes(16).toString("hex");
  const text = `g8 recovered ${ctx.config.runId}`;
  const receivedAt = new Date(ctx.clock.now() - 15 * 60_000).toISOString();
  const key = `envelopes/${boot.projectId}/${encodeURIComponent(receivedAt)}/${eventId}/g8cron-${ctx.config.runId}`;
  const planted = await ctx.http(
    "POST",
    `https://storage.googleapis.com/upload/storage/v1/b/${ctx.names.bucket}/o?uploadType=media&name=${encodeURIComponent(key)}`,
    {
      body: buildEnvelope(eventId, text),
      headers: { "content-type": "application/octet-stream" },
    },
  );
  if (
    !report.check(
      "stale envelope planted without a queue message",
      ok(planted),
      `status ${planted.status}`,
    )
  )
    return;
  const job = ctx.names.job("staged-recovery");
  if (!ctx.flags.natural) {
    const forced = await ctx.http("POST", `${SCHEDULER}/${job}:run`, {
      json: {},
    });
    report.check(
      "the scheduler job was run on demand",
      ok(forced),
      `status ${forced.status}`,
    );
  }
  const started = ctx.clock.now();
  const lookup = async () =>
    (
      await ctx.http(
        "GET",
        `${api}/api/0/projects/${ctx.config.org}/${ctx.config.projectSlug}/issues/?limit=100`,
        { token: boot.token },
      )
    ).json?.find((item) => String(item.title).includes(text));
  let issue;
  try {
    issue = await ctx.poll("recovered", lookup, {
      timeoutMs: ctx.flags.natural ? 600_000 : 300_000,
      intervalMs: 5000,
    });
  } catch {
    issue = undefined;
  }
  report.check(
    "the cron run recovered the stale envelope exactly once",
    issue?.count === "1",
    () =>
      `after ${Math.round((ctx.clock.now() - started) / 1000)} s, count ${issue?.count ?? "none"}`,
  );
  const state = await ctx.http("GET", `${SCHEDULER}/${job}`);
  report.check(
    "the last scheduler attempt succeeded",
    ok(state) &&
      Boolean(state.json?.lastAttemptTime) &&
      !state.json?.status?.code,
    () => `status code ${state.json?.status?.code ?? 0}`,
  );
  await ctx.http(
    "DELETE",
    `https://storage.googleapis.com/storage/v1/b/${ctx.names.bucket}/o/${encodeURIComponent(key)}`,
    { raw: true },
  );
}

async function run(ctx) {
  await jobConfiguration(ctx);
  await recovery(ctx);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main([probe]));
