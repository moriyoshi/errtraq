import { fileURLToPath } from "node:url";
import { main, ok } from "./lib.mjs";

/**
 * The deployed shape: Cloud Run service settings (concurrency, instance caps, CPU and memory in the
 * accepted formats, no key files, the service account per function), the first-request latency of
 * the services that can be called without being the push or Scheduler account (cold start after
 * idling), the bootstrap secret converging on one version, and the Pub/Sub service agent's token
 * creator grant on the push account.
 */
export const probe = {
  name: "deploy",
  description:
    "Cloud Run settings, cold start, bootstrap secret versions, service agent grant",
  run,
};

/** The designed values (FUNCTION_DEFAULTS in packages/platforms/cloud-run). */
export const EXPECTED = {
  ingest: { concurrency: 80 },
  api: { concurrency: 80 },
  consumer: { concurrency: 8 },
  record: { concurrency: 8 },
  cron: { concurrency: 1 },
  bootstrap: { concurrency: 1 },
};

export async function serviceSettings(ctx) {
  for (const [fn, expected] of Object.entries(EXPECTED)) {
    const response = await ctx.http(
      "GET",
      `https://run.googleapis.com/v2/${ctx.names.service(fn)}`,
    );
    if (response.status === 404) {
      ctx.report.skip(`service ${fn}`, "not deployed in this stack");
      continue;
    }
    const template = response.json?.template ?? {};
    const container = template.containers?.[0] ?? {};
    const env = (container.env ?? []).map((item) => item.name);
    const problems = [];
    if (template.maxInstanceRequestConcurrency !== expected.concurrency)
      problems.push(`concurrency ${template.maxInstanceRequestConcurrency}`);
    if (template.scaling?.maxInstanceCount !== 20)
      problems.push(`max instances ${template.scaling?.maxInstanceCount}`);
    if (
      container.resources?.limits?.cpu !== "1" &&
      container.resources?.limits?.cpu !== "1000m"
    )
      problems.push(`cpu ${container.resources?.limits?.cpu}`);
    if (container.resources?.limits?.memory !== "512Mi")
      problems.push(`memory ${container.resources?.limits?.memory}`);
    if (template.serviceAccount !== ctx.names.serviceAccount(fn))
      problems.push("service account");
    if (env.includes("GOOGLE_APPLICATION_CREDENTIALS"))
      problems.push("a key file variable is set");
    ctx.report.check(
      `service ${fn} has the designed settings`,
      ok(response) && problems.length === 0,
      () => problems.join(", "),
    );
  }
}

/** First request after idling; the services must have scaled to zero for this to be a cold start. */
export async function coldStart(ctx) {
  for (const fn of ["ingest", "api", "bootstrap"]) {
    let url;
    try {
      url = await ctx.url(fn);
    } catch {
      ctx.report.skip(`cold start ${fn}`, "no URL");
      continue;
    }
    const token =
      fn === "bootstrap" ? await ctx.auth.idToken(ctx.config.audience) : "none";
    const started = ctx.clock.now();
    const response = await ctx.http("GET", `${url}/_errtraq/health`, {
      token,
      timeoutMs: 60_000,
    });
    const first = ctx.clock.now() - started;
    const again = ctx.clock.now();
    await ctx.http("GET", `${url}/_errtraq/health`, { token });
    const second = ctx.clock.now() - again;
    ctx.report.check(
      `${fn} answers its first request`,
      ok(response) && first < 30_000,
      () => `status ${response.status}`,
    );
    ctx.report.info(
      `cold start ${fn}`,
      `first ${first} ms, second ${second} ms (cold only if the service idled for 15 minutes or more)`,
    );
  }
}

/** Concurrent bootstraps converge on one secret version. */
export async function secretVersions(ctx) {
  const response = await ctx.http(
    "GET",
    `https://secretmanager.googleapis.com/v1/${ctx.names.secret}/versions`,
  );
  const versions = response.json?.versions ?? [];
  ctx.report.check(
    "the bootstrap secret has exactly one version",
    ok(response) && versions.length === 1,
    () => `${versions.length} version(s)`,
  );
}

export async function serviceAgent(ctx) {
  const response = await ctx.http(
    "POST",
    `https://iam.googleapis.com/v1/projects/${ctx.config.project}/serviceAccounts/${ctx.names.pushServiceAccount}:getIamPolicy`,
    { json: {} },
  );
  const members = (response.json?.bindings ?? [])
    .filter(
      (binding) => binding.role === "roles/iam.serviceAccountTokenCreator",
    )
    .flatMap((binding) => binding.members ?? []);
  ctx.report.check(
    "the Pub/Sub service agent holds token creator on the push account",
    ok(response) &&
      members.some((member) =>
        /gcp-sa-pubsub\.iam\.gserviceaccount\.com$/.test(member),
      ),
    () => `status ${response.status}, ${members.length} member(s)`,
  );
}

async function run(ctx) {
  const steps = {
    cold: coldStart,
    settings: serviceSettings,
    secret: secretVersions,
    agent: serviceAgent,
  };
  for (const name of String(
    ctx.flags.only ?? Object.keys(steps).join(","),
  ).split(","))
    if (steps[name]) await steps[name](ctx);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exit(await main([probe]));
