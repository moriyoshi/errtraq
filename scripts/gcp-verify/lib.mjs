import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Shared plumbing of the operator-run G8 probes (`scripts/gcp-verify/`): configuration from flags
 * and the environment (nothing environment specific is written down in the repository), an
 * output scrubber, a small REST helper over an injectable `fetch`, token sources that never
 * persist a token, polling with an injectable clock, and a PASS / FAIL / SKIP reporter.
 */

export const DEFAULT_STACK = "gcp-g8";
export const DEFAULT_AUDIENCE = "errtraq-push";
export const DEFAULT_SECRET = "errtraq-bootstrap-gcp-g8";
export const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";

/** `--flag value` and `--switch` arguments; unknown flags are kept so each probe can read its own. */
export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--"))
      flags[arg.slice(2)] = argv[++i];
    else flags[arg.slice(2)] = true;
  }
  return { flags, positional };
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const REGION = /^[a-z]+-[a-z]+[0-9]+$/;
const STACK = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;

/**
 * The run configuration. `project` and `region` have no default anywhere: they come from
 * `--project` / `--region` or `ERRTRAQ_GCP_PROJECT` / `ERRTRAQ_GCP_REGION`.
 */
export function loadConfig(flags, env = {}) {
  const pick = (flag, variable, fallback) => {
    const value = flags[flag] ?? env[variable] ?? fallback;
    return value === true ? undefined : value;
  };
  const project = pick("project", "ERRTRAQ_GCP_PROJECT");
  const region = pick("region", "ERRTRAQ_GCP_REGION");
  if (!project || !PROJECT.test(project))
    throw new Error("Set --project or ERRTRAQ_GCP_PROJECT (a project id)");
  if (!region || !REGION.test(region))
    throw new Error(
      "Set --region or ERRTRAQ_GCP_REGION (for example a region name)",
    );
  const stack = pick("stack", "ERRTRAQ_GCP_STACK", DEFAULT_STACK);
  if (!STACK.test(stack)) throw new Error("Invalid stack name");
  return {
    project,
    region,
    stack,
    outputsPath: pick("outputs", "ERRTRAQ_GCP_OUTPUTS"),
    statePath: pick("state", "ERRTRAQ_GCP_STATE"),
    bootstrapSecret: pick(
      "bootstrap-secret",
      "ERRTRAQ_GCP_BOOTSTRAP_SECRET",
      DEFAULT_SECRET,
    ),
    org: pick("org", "ERRTRAQ_GCP_ORG", "default"),
    projectSlug: pick("project-slug", "ERRTRAQ_GCP_PROJECT_SLUG", "default"),
    audience: pick("audience", "ERRTRAQ_GCP_AUDIENCE", DEFAULT_AUDIENCE),
    repository: pick("repo", "ERRTRAQ_GCP_AR_REPO"),
    stateDir: pick(
      "state-dir",
      "ERRTRAQ_GCP_STATE_DIR",
      ".agents-workspace/tmp/g8",
    ),
    runId:
      pick("run-id", "ERRTRAQ_GCP_RUN_ID") ?? randomBytes(3).toString("hex"),
    flags,
  };
}

/** Resource names derived from the stack name, the way the Terraform modules derive them. */
export function names(config) {
  const { project, stack } = config;
  const role = stack.replaceAll("-", "_");
  return {
    bucket: `${stack}-${project}-blob`,
    topic: (physical) => `projects/${project}/topics/${stack}-${physical}`,
    subscription: (physical) =>
      `projects/${project}/subscriptions/${stack}-${physical}`,
    dlqTopic: (physical) =>
      `projects/${project}/topics/${stack}-${physical}-dlq`,
    dlqSubscription: (physical) =>
      `projects/${project}/subscriptions/${stack}-${physical}-dlq`,
    service: (fn) =>
      `projects/${project}/locations/${config.region}/services/${stack}-${fn}`,
    serviceAccount: (fn) => `${stack}-${fn}@${project}.iam.gserviceaccount.com`,
    pushServiceAccount: `errtraq-push@${project}.iam.gserviceaccount.com`,
    schedulerServiceAccount: `errtraq-scheduler@${project}.iam.gserviceaccount.com`,
    database: (purpose) => `projects/${project}/databases/${stack}-${purpose}`,
    databaseId: (purpose) => `${stack}-${purpose}`,
    job: (name) =>
      `projects/${project}/locations/${config.region}/jobs/${stack}-${name}`,
    secret: `projects/${project}/secrets/${config.bootstrapSecret}`,
    rolePrefix: role,
  };
}

/**
 * Replaces everything that identifies the environment (project, region, e-mail addresses, URLs,
 * tokens, numeric project ids) with placeholders. Probes print only scrubbed text.
 */
export function createScrubber(config) {
  const literals = new Map();
  const add = (value, placeholder) => {
    if (typeof value === "string" && value.length >= 3)
      literals.set(value, placeholder);
  };
  add(config.project, "<project>");
  add(config.region, "<region>");
  return {
    /** Register a value (an API token, a public key, a project number) that must never be printed. */
    addSecret(value, placeholder = "<secret>") {
      add(value, placeholder);
    },
    scrub(text) {
      let out = String(text);
      out = out.replace(/https?:\/\/[^\s"'<>)\]]+/g, "<url>");
      out = out.replace(
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
        "<token>",
      );
      out = out.replace(/\bya29\.[A-Za-z0-9._-]+/g, "<token>");
      out = out.replace(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        "<email>",
      );
      for (const [value, placeholder] of [...literals].sort(
        (a, b) => b[0].length - a[0].length,
      ))
        out = out.split(value).join(placeholder);
      return out;
    },
  };
}

export function createReporter({ print = console.log, scrub }) {
  const results = [];
  const emit = (status, name, detail) => {
    results.push({ status, name, detail: detail ?? "" });
    print(scrub(`${status} ${name}${detail ? `: ${detail}` : ""}`));
  };
  return {
    results,
    pass: (name, detail) => emit("PASS", name, detail),
    fail: (name, detail) => emit("FAIL", name, detail),
    skip: (name, detail) => emit("SKIP", name, detail),
    info: (name, detail) => {
      print(scrub(`INFO ${name}${detail ? `: ${detail}` : ""}`));
    },
    /** `ok` true passes, false fails; `detail` may be a function so it is only built when needed. */
    check(name, ok, detail) {
      emit(
        ok ? "PASS" : "FAIL",
        name,
        typeof detail === "function" ? detail() : detail,
      );
      return ok;
    },
    summary() {
      const count = (status) =>
        results.filter((item) => item.status === status).length;
      return { pass: count("PASS"), fail: count("FAIL"), skip: count("SKIP") };
    },
  };
}

export class PollTimeout extends Error {}

export function createClock({ sleep, now } = {}) {
  return {
    sleep: sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
    now: now ?? (() => Date.now()),
  };
}

/** Run `fn` until it returns a truthy value; throws PollTimeout (never retries thrown errors silently). */
export async function poll(
  clock,
  label,
  fn,
  { timeoutMs = 60_000, intervalMs = 1000 } = {},
) {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (clock.now() >= deadline) throw new PollTimeout(`timed out: ${label}`);
    await clock.sleep(intervalMs);
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** `terraform output -json` is `{ name: { value } }`; returns `{ name: value }`. */
export async function loadOutputs(path, read = (p) => readFile(p, "utf8")) {
  if (!path) return {};
  let parsed;
  try {
    parsed = JSON.parse(await read(resolve(path)));
  } catch {
    throw new Error(
      "Cannot read the Terraform outputs file (expected `terraform output -json`)",
    );
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([name, item]) => [
      name,
      item && typeof item === "object" && "value" in item ? item.value : item,
    ]),
  );
}

/**
 * Token sources. Tokens live in memory only. The access token comes from
 * `ERRTRAQ_GCP_ACCESS_TOKEN` (for example `gcloud auth print-access-token`) or an injected
 * function; ID tokens come from `ERRTRAQ_GCP_ID_TOKEN` (one fixed audience), by impersonating a
 * service account through IAM Credentials (`ERRTRAQ_GCP_IMPERSONATE_SA` or a per-call `as`), or
 * from an injected function (a service account key through `packages/gcp-auth`).
 */
export function createAuth({
  env = {},
  fetch: fetcher = fetch,
  accessToken,
  idToken,
} = {}) {
  const access =
    accessToken ??
    (async () => {
      if (env.ERRTRAQ_GCP_ACCESS_TOKEN) return env.ERRTRAQ_GCP_ACCESS_TOKEN;
      throw new Error(
        "Set ERRTRAQ_GCP_ACCESS_TOKEN (for example from `gcloud auth print-access-token`)",
      );
    });
  const iam = async (email, action, body) => {
    const response = await fetcher(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:${action}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await access()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        `IAM Credentials ${action} was refused (${response.status}); the caller needs roles/iam.serviceAccountTokenCreator on the target`,
      );
    return parsed;
  };
  return {
    accessToken: () => access(),
    /** An access token of `email`, minted through impersonation. */
    async impersonatedAccessToken(email) {
      const parsed = await iam(email, "generateAccessToken", {
        scope: [CLOUD_PLATFORM],
      });
      if (typeof parsed.accessToken !== "string")
        throw new Error("Malformed generateAccessToken response");
      return parsed.accessToken;
    },
    async idToken(audience, { as } = {}) {
      const target = as ?? env.ERRTRAQ_GCP_IMPERSONATE_SA;
      if (target) {
        const parsed = await iam(target, "generateIdToken", {
          audience,
          includeEmail: true,
        });
        if (typeof parsed.token !== "string")
          throw new Error("Malformed generateIdToken response");
        return parsed.token;
      }
      if (idToken) return idToken(audience);
      if (env.ERRTRAQ_GCP_ID_TOKEN) return env.ERRTRAQ_GCP_ID_TOKEN;
      throw new Error(
        "No ID token source: set ERRTRAQ_GCP_IMPERSONATE_SA, ERRTRAQ_GCP_ID_TOKEN or use a service account key",
      );
    },
  };
}

/** A fetch wrapper: bearer token by kind, scrubbed network errors, never throws on an HTTP status. */
export function createHttp({
  fetch: fetcher = fetch,
  auth,
  scrub,
  timeoutMs = 30_000,
}) {
  return async function http(method, url, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    const token = options.token ?? "access";
    if (token === "access") {
      // An empty token means no Authorization header (emulators).
      const value = await auth.accessToken();
      if (value) headers.authorization = `Bearer ${value}`;
    } else if (token !== "none") headers.authorization = `Bearer ${token}`;
    let body = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["content-type"] ??= "application/json";
    }
    let response;
    try {
      response = await fetcher(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(options.timeoutMs ?? timeoutMs),
      });
    } catch (error) {
      return {
        status: 0,
        headers: new Headers(),
        text: "",
        json: null,
        error: scrub(
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : "network error",
        ),
      };
    }
    const text = options.raw ? "" : await response.text().catch(() => "");
    let json = null;
    if (!options.raw)
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
    return {
      status: response.status,
      headers: response.headers,
      text,
      json,
      response,
    };
  };
}

export const ok = (response) => response.status >= 200 && response.status < 300;
export const errorStatus = (response) =>
  response.json?.error?.status ??
  response.json?.error?.errors?.[0]?.reason ??
  "";

/**
 * Everything a probe needs. `deps` injects fetch, clock, auth, the Sentry factory and the print
 * function so every probe runs offline in unit tests.
 */
export async function createContext(config, deps = {}) {
  const scrubber = createScrubber(config);
  const print = deps.print ?? console.log;
  const reporter = createReporter({ print, scrub: scrubber.scrub });
  const env = deps.env ?? {};
  const auth = deps.auth ?? createAuth({ env, fetch: deps.fetch });
  const http = createHttp({
    fetch: deps.fetch,
    auth,
    scrub: scrubber.scrub,
    timeoutMs: deps.timeoutMs,
  });
  const clock = createClock(deps.clock);
  const outputs = deps.outputs ?? (await loadOutputs(config.outputsPath));
  const ctx = {
    config,
    flags: config.flags,
    env,
    names: names(config),
    auth,
    http,
    clock,
    report: reporter,
    scrub: scrubber.scrub,
    addSecret: scrubber.addSecret,
    outputs,
    deps,
    poll: (label, fn, options) => poll(clock, label, fn, options),
    pool,
    cache: new Map(),
  };
  /** The Cloud Run service of function `fn` (`uri`, service account), from the Admin API. */
  ctx.service = async (fn) => {
    const key = `service:${fn}`;
    if (!ctx.cache.has(key)) {
      const response = await http(
        "GET",
        `https://run.googleapis.com/v2/${ctx.names.service(fn)}`,
      );
      if (!ok(response))
        throw new Error(`Cannot read the ${fn} service (${response.status})`);
      ctx.cache.set(key, response.json);
    }
    return ctx.cache.get(key);
  };
  /** Base URL (no trailing slash): from Terraform outputs when present, else the Admin API. */
  ctx.url = async (fn) => {
    const fromOutput = outputs[`${fn}_url`];
    const uri =
      typeof fromOutput === "string" && fromOutput
        ? fromOutput
        : (await ctx.service(fn)).uri;
    if (typeof uri !== "string" || !uri) throw new Error(`No URL for ${fn}`);
    return uri.replace(/\/$/, "");
  };
  /** The DSN and API token the bootstrap run wrote to Secret Manager. Both are registered for scrubbing. */
  ctx.bootstrap = async () => {
    if (!ctx.cache.has("bootstrap")) {
      const response = await http(
        "GET",
        `https://secretmanager.googleapis.com/v1/${ctx.names.secret}/versions/latest:access`,
      );
      if (!ok(response) || typeof response.json?.payload?.data !== "string")
        throw new Error(
          `Cannot read the bootstrap secret (${response.status}); run the bootstrap first`,
        );
      const value = JSON.parse(
        Buffer.from(response.json.payload.data, "base64").toString("utf8"),
      );
      const dsn = new URL(value.dsn);
      const result = {
        dsn: value.dsn,
        token: value.token,
        publicKey: dsn.username,
        projectId: dsn.pathname.replace(/^\//, ""),
      };
      scrubber.addSecret(result.token, "<api-token>");
      scrubber.addSecret(result.publicKey, "<dsn-key>");
      ctx.cache.set("bootstrap", result);
    }
    return ctx.cache.get("bootstrap");
  };
  return ctx;
}

/** Run one probe, converting a thrown error into a scrubbed FAIL so the other probes still run. */
export async function runProbe(probe, ctx) {
  ctx.report.info(`probe ${probe.name}`, probe.description);
  try {
    await probe.run(ctx);
  } catch (error) {
    ctx.report.fail(
      `${probe.name}: aborted`,
      error instanceof Error ? error.message : "error",
    );
  }
}

/** CLI entry shared by every probe file and by run.mjs. */
export async function main(
  probes,
  argv = process.argv.slice(2),
  env = process.env,
  deps = {},
) {
  const { flags } = parseFlags(argv);
  const config = loadConfig(flags, env);
  const ctx = await createContext(config, { env, ...deps });
  for (const probe of probes) await runProbe(probe, ctx);
  const summary = ctx.report.summary();
  ctx.report.info(
    "summary",
    `${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped`,
  );
  return summary.fail === 0 ? 0 : 1;
}

export const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
export const sha256hex = async (bytes) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
