import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { main, ok } from "./lib.mjs";

/**
 * SDK end to end through the deployed ingest URL, with the real `@sentry/node` unless a factory
 * is injected: 401 on bad keys and tokens, grouping, resolve then regress, and a duplicate
 * envelope counted once (the M3h AWS run's checks, now on Cloud Run).
 */
export const probe = {
  name: "sdk",
  description:
    "real Sentry SDK through ingest, grouping, resolve and regress, duplicate envelope",
  run,
};

/** The default factory: real `@sentry/node`, one client for the whole probe. */
export async function realSentry({ dsn, release }) {
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn,
    release,
    defaultIntegrations: false,
    tracesSampleRate: 0,
  });
  return {
    captureException: (error) => Sentry.captureException(error),
    captureMessage: (text) => Sentry.captureMessage(text),
    flush: (ms) => Sentry.flush(ms),
    close: (ms) => Sentry.close(ms),
  };
}

const eventId = () => randomBytes(16).toString("hex");
/** A hand-built envelope with one event (used where the exact event id matters). */
export function buildEnvelope(id, message) {
  return `${JSON.stringify({ event_id: id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: id, message, level: "error", platform: "node", timestamp: Date.now() / 1000 })}\n`;
}
/** An error class whose name is unique to this run, so its issue never merges with an earlier run's. */
export function uniqueError(tag, label, index) {
  const error = new Error(`g8 ${label} ${index}`);
  Object.defineProperty(error, "name", { value: `${tag}${label}Error` });
  return error;
}

async function run(ctx) {
  const { report } = ctx;
  const boot = await ctx.bootstrap();
  const ingest = await ctx.url("ingest");
  const api = await ctx.url("api");
  const base = `/api/0/projects/${ctx.config.org}/${ctx.config.projectSlug}`;
  const tag = `G8${ctx.config.runId.replace(/[^A-Za-z0-9]/g, "")}`;
  const envelopeUrl = (key) =>
    `${ingest}/api/${boot.projectId}/envelope/${key === undefined ? "" : `?sentry_key=${key}`}`;
  const get = (path, token = boot.token) =>
    ctx.http("GET", `${api}${path}`, { token });

  // 1. Authentication on both public surfaces.
  const body = buildEnvelope(eventId(), `g8 ${tag} rejected`);
  const missing = await ctx.http("POST", envelopeUrl(undefined), {
    body,
    token: "none",
  });
  const wrong = await ctx.http("POST", envelopeUrl("0".repeat(32)), {
    body,
    token: "none",
  });
  report.check(
    "ingest rejects a missing and a wrong key",
    [401, 403].includes(missing.status) && [401, 403].includes(wrong.status),
    `missing ${missing.status}, wrong ${wrong.status}`,
  );
  const anonymous = await ctx.http("GET", `${api}${base}/issues/`, {
    token: "none",
  });
  const badToken = await get(`${base}/issues/`, "not-a-token");
  report.check(
    "API rejects a missing and a wrong token",
    anonymous.status === 401 && badToken.status === 401,
    `missing ${anonymous.status}, wrong ${badToken.status}`,
  );

  // 2. Grouping through the SDK.
  const dsn = `https://${boot.publicKey}@${new URL(ingest).host}/${boot.projectId}`;
  const factory = ctx.deps.sentry ?? realSentry;
  const sdk = await factory({ dsn, release: `g8-${tag}` });
  try {
    for (let i = 0; i < 3; i++)
      sdk.captureException(uniqueError(tag, "Alpha", i));
    sdk.captureException(uniqueError(tag, "Beta", 0));
    sdk.captureMessage(`g8 ${tag} message`);
    report.check("SDK flushed every event", (await sdk.flush(20_000)) === true);
    const find = (issues, text) =>
      issues.find((issue) => String(issue.title).includes(text));
    let issues;
    try {
      issues = await ctx.poll(
        "issues grouped",
        async () => {
          const response = await get(`${base}/issues/?limit=100`);
          const rows = (response.json ?? []).filter((issue) =>
            String(issue.title).includes(tag),
          );
          return rows.length >= 3 && find(rows, `${tag}Alpha`)?.count === "3"
            ? rows
            : undefined;
        },
        { timeoutMs: 120_000, intervalMs: 2000 },
      );
    } catch {
      issues = undefined;
    }
    const alpha = issues && find(issues, `${tag}Alpha`);
    const beta = issues && find(issues, `${tag}Beta`);
    const message = issues && find(issues, `${tag} message`);
    report.check(
      "same error groups into one issue (3, 1, 1)",
      alpha?.count === "3" && beta?.count === "1" && message?.count === "1",
      () =>
        `counts ${alpha?.count ?? "none"}, ${beta?.count ?? "none"}, ${message?.count ?? "none"}`,
    );
    if (!alpha) return;
    const latest = await get(`/api/0/issues/${alpha.id}/events/latest/`);
    report.check(
      "latest event is readable",
      ok(latest) && typeof latest.json?.eventID === "string",
      `status ${latest.status}`,
    );

    // 3. Resolve, then a new event reopens the issue.
    const resolved = await ctx.http("PUT", `${api}/api/0/issues/${alpha.id}/`, {
      token: boot.token,
      json: { status: "resolved" },
    });
    report.check(
      "issue resolves through the API",
      ok(resolved) && resolved.json?.status === "resolved",
      `status ${resolved.status}`,
    );
    await ctx.clock.sleep(1500);
    sdk.captureException(uniqueError(tag, "Alpha", 3));
    await sdk.flush(20_000);
    let regressed;
    try {
      regressed = await ctx.poll(
        "regression",
        async () => {
          const issue = (await get(`/api/0/issues/${alpha.id}/`)).json;
          return issue?.count === "4" && issue.status === "unresolved"
            ? issue
            : undefined;
        },
        { timeoutMs: 120_000, intervalMs: 2000 },
      );
    } catch {
      regressed = undefined;
    }
    report.check(
      "a new event after resolve reopens the issue (count 4)",
      regressed !== undefined,
    );
  } finally {
    await sdk.close(2000).catch(() => undefined);
  }

  // 4. The same envelope posted twice counts once.
  const duplicateId = eventId();
  const text = `g8 ${tag} duplicate`;
  const first = await ctx.http("POST", envelopeUrl(boot.publicKey), {
    body: buildEnvelope(duplicateId, text),
    token: "none",
  });
  const second = await ctx.http("POST", envelopeUrl(boot.publicKey), {
    body: buildEnvelope(duplicateId, text),
    token: "none",
  });
  report.check(
    "a duplicate envelope is accepted",
    ok(first) && ok(second),
    `${first.status}, ${second.status}`,
  );
  let duplicate;
  try {
    duplicate = await ctx.poll(
      "duplicate recorded",
      async () =>
        (await get(`${base}/issues/?limit=100`)).json?.find((issue) =>
          String(issue.title).includes(text),
        ),
      { timeoutMs: 120_000, intervalMs: 2000 },
    );
    await ctx.clock.sleep(10_000);
    duplicate = (await get(`${base}/issues/?limit=100`)).json?.find((issue) =>
      String(issue.title).includes(text),
    );
  } catch {
    duplicate = undefined;
  }
  report.check(
    "a duplicate envelope is counted once",
    duplicate?.count === "1",
    () => `count ${duplicate?.count ?? "none"}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main([probe]));
