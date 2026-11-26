import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { bootstrapDeployed } from "@moriyoshi/errtraq-core";
import { create as createKv } from "@moriyoshi/errtraq-kv-firestore/runtime";
import { create as createStore } from "@moriyoshi/errtraq-store-firestore/runtime";
import * as Sentry from "@sentry/node";
import { freePort, PROJECT } from "./containers.mjs";

const STACK = "gcp-emulated";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A metadata server that issues a dummy token: the emulators never check it. */
async function startMetadata() {
  const server = createServer((request, response) => {
    if (request.headers["metadata-flavor"] !== "Google") {
      response.writeHead(403).end();
      return;
    }
    if (request.url?.includes("/token"))
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          access_token: "owner",
          expires_in: 3000,
          token_type: "Bearer",
        }),
      );
    else if (request.url?.endsWith("/email"))
      response
        .writeHead(200)
        .end("handler@errtraq-test.iam.gserviceaccount.com");
    else response.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    host: `127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  };
}
async function admin(origin, method, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `${method} ${path} failed (${response.status}): ${await response.text()}`,
    );
}

/**
 * End to end against the emulators: the Cloud Run handler built by `errtraq build` runs as a
 * process, real `@sentry/node` sends errors to its ingest, the Pub/Sub emulator pushes them back
 * to `/_errtraq/push/<physical>`, and the API shows grouped, counted issues.
 */
export async function runE2e(emulators) {
  const root = resolve(".agents-workspace/tmp");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "g7-e2e-"));
  const metadata = await startMetadata();
  const handlerPort = await freePort();
  const bucket = `errtraq-e2e-${Date.now().toString(36)}`;
  const topic = `projects/${PROJECT}/topics/${STACK}-shared`;
  const subscription = `projects/${PROJECT}/subscriptions/${STACK}-shared`;
  let child;
  let logs = "";
  try {
    // 1. Build the handler of a stack wired to the emulators.
    const built = spawnSync(
      process.execPath,
      [
        "packages/cli/dist/bin.js",
        "build",
        "--stack",
        "scripts/gcp-emulated/stack.ts",
        "--out",
        join(directory, "build"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ERRTRAQ_GCP_EMULATOR_GCS_ENDPOINT: emulators.gcsOrigin,
        },
      },
    );
    assert.equal(built.status, 0, `build failed: ${built.stderr}`);
    // 2. Resources that Terraform creates in a deployment.
    await admin(
      emulators.gcsOrigin,
      "POST",
      `/storage/v1/b?project=${PROJECT}`,
      { name: bucket },
    );
    const pubsub = `http://${emulators.env.PUBSUB_EMULATOR_HOST}`;
    await admin(pubsub, "PUT", `/v1/${topic}`, {});
    await admin(pubsub, "PUT", `/v1/${subscription}`, {
      topic,
      ackDeadlineSeconds: 60,
      // The emulator reaches the handler through the container host alias; it sends no OIDC token.
      pushConfig: {
        pushEndpoint: `http://${process.env.ERRTRAQ_PUBSUB_PUSH_HOST ?? "host.docker.internal"}:${handlerPort}/_errtraq/push/shared`,
      },
    });
    // 3. Bootstrap the project the way the bootstrap role does, with an in-memory vault.
    const environment = {
      FIRESTORE_EMULATOR_HOST: emulators.env.FIRESTORE_EMULATOR_HOST,
    };
    const bindings = {
      ERRTRAQ_STORE_DATABASE: "(default)",
      ERRTRAQ_KV_DATABASE: "(default)",
    };
    const store = createStore({
      config: { projectId: PROJECT, location: "europe-west1" },
      bindings,
      environment,
    });
    const kv = createKv({
      config: { projectId: PROJECT, location: "europe-west1" },
      bindings,
      environment,
    });
    let secret;
    await bootstrapDeployed({
      stackName: STACK,
      store,
      kv,
      vault: {
        async claim(_name, candidate) {
          secret ??= candidate;
          return { identifier: "memory", value: secret };
        },
      },
      secretName: "bootstrap",
      ingestUrl: "https://errtraq.example/",
      orgSlug: "default",
      projectSlug: "default",
    });
    const { dsn: deployedDsn, token } = JSON.parse(secret);
    const key = new URL(deployedDsn).username;
    const projectId = new URL(deployedDsn).pathname.slice(1);
    // 4. Run the handler like a Cloud Run instance.
    child = spawn(
      process.execPath,
      [join(directory, "build", "shared", "index.mjs")],
      {
        env: {
          ...process.env,
          PORT: String(handlerPort),
          GCE_METADATA_HOST: metadata.host,
          FIRESTORE_EMULATOR_HOST: emulators.env.FIRESTORE_EMULATOR_HOST,
          PUBSUB_EMULATOR_HOST: emulators.env.PUBSUB_EMULATOR_HOST,
          ERRTRAQ_STORE_DATABASE: "(default)",
          ERRTRAQ_KV_DATABASE: "(default)",
          ERRTRAQ_BLOB_BUCKET: bucket,
          ERRTRAQ_QUEUE_SHARED_TOPIC: topic,
          ERRTRAQ_QUEUE_SOURCE_SHARED: subscription,
          ERRTRAQ_INGEST_RATE_LIMIT: "disabled",
          ERRTRAQ_OIDC_AUDIENCE: "errtraq-push",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    for (const stream of [child.stdout, child.stderr])
      stream.setEncoding("utf8").on("data", (chunk) => {
        logs = (logs + chunk).slice(-6000);
      });
    const origin = `http://127.0.0.1:${handlerPort}`;
    const waitFor = async (fn, label) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          throw new Error(`handler exited during ${label}:\n${logs}`);
        const value = await fn().catch(() => undefined);
        if (value) return value;
        await delay(200);
      }
      throw new Error(`timed out: ${label}\n${logs}`);
    };
    await waitFor(
      async () => (await fetch(`${origin}/_errtraq/health`)).ok,
      "handler health",
    );
    // The internal routes stay closed to anyone without the platform's credentials.
    const cron = await fetch(`${origin}/_errtraq/cron/staged-recovery`, {
      method: "POST",
    });
    assert.equal(cron.status, 401, "cron route requires a Scheduler token");
    // 5. Real Sentry SDK traffic.
    Sentry.init({
      dsn: `http://${key}@127.0.0.1:${handlerPort}/${projectId}`,
      release: "g7-release",
    });
    const first = (index) => new TypeError(`first failure ${index}`);
    for (let i = 0; i < 3; i++) Sentry.captureException(first(i));
    Sentry.captureException(new RangeError("second failure"));
    Sentry.captureMessage("fixture message");
    assert.equal(
      await Sentry.flush(15000),
      true,
      "the SDK delivered every event",
    );
    // 6. The emulator pushes the queued events back; the API shows the outcome.
    const headers = { authorization: `Bearer ${token}` };
    const api = async (path) => {
      const response = await fetch(`${origin}${path}`, { headers });
      assert.equal(
        response.status,
        200,
        `API ${path}: ${await response.clone().text()}`,
      );
      return response.json();
    };
    let issues;
    try {
      issues = await waitFor(async () => {
        const rows = await api("/api/0/projects/default/default/issues/");
        return rows.length === 3 && rows.some((row) => Number(row.count) === 3)
          ? rows
          : undefined;
      }, "issues grouped through Pub/Sub push");
    } catch (error) {
      throw new Error(`${error.message}\nhandler log:\n${logs}`);
    }
    const byTitle = (text) => issues.find((row) => row.title.includes(text));
    assert.equal(
      byTitle("first failure")?.count,
      "3",
      "same error grouped into one issue",
    );
    assert.equal(byTitle("second failure")?.count, "1");
    assert.equal(byTitle("fixture message")?.count, "1");
    const events = await api(
      `/api/0/issues/${byTitle("first failure").id}/events/`,
    );
    assert.equal(
      events.length,
      3,
      "every event of the grouped issue is stored",
    );
    assert.equal(
      (await fetch(`${origin}/api/0/projects/default/default/issues/`)).status,
      401,
      "the API rejects anonymous callers",
    );
    console.log(
      "PASS end to end: 5 events through ingest, Pub/Sub push and the API grouped into 3 issues",
    );
  } finally {
    await Sentry.close(1000).catch(() => undefined);
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        delay(5000),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    metadata.close();
  }
}
