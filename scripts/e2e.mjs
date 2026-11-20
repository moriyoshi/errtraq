import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { create as createBlobs } from "@errtraq/blob-fs";
import * as Sentry from "@sentry/node";

const root = resolve(".agents-workspace/tmp");
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, "m1d-e2e-"));
const child = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "packages/cli/dist/bin.js",
    "dev",
    "--stack",
    "stacks/local.ts",
  ],
  {
    env: { ...process.env, ERRTRAQ_DATA_DIR: directory, ERRTRAQ_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let output = "",
  errors = "";
let shutdownFailure;
child.stdout.setEncoding("utf8").on("data", (chunk) => {
  output += chunk;
});
child.stderr.setEncoding("utf8").on("data", (chunk) => {
  errors += chunk;
});
const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function waitFor(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Server stopped before ${label}: ${errors}`);
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${errors}`);
}
try {
  await waitFor(
    () => output.includes("Listening:") && output.includes("API token:"),
    "server startup",
  );
  const dsn = output.match(/^DSN: (.+)$/m)?.[1];
  const token = output.match(/^API token: (.+)$/m)?.[1];
  const origin = output.match(/^Listening: (.+)$/m)?.[1];
  assert.ok(dsn && token && origin);
  const url = new URL(dsn);
  const ingest = `${origin}/api/${url.pathname.slice(1)}/envelope/?sentry_key=${url.username}`;
  let replay;
  function serialize([headers, items]) {
    const parts = [Buffer.from(`${JSON.stringify(headers)}\n`)];
    for (const [header, item] of items) {
      const body =
        item instanceof Uint8Array
          ? Buffer.from(item)
          : Buffer.from(typeof item === "string" ? item : JSON.stringify(item));
      parts.push(
        Buffer.from(`${JSON.stringify({ ...header, length: body.length })}\n`),
        body,
        Buffer.from("\n"),
      );
    }
    return Buffer.concat(parts);
  }
  Sentry.init({
    dsn,
    integrations: (defaults) =>
      defaults.filter((integration) => integration.name !== "Dedupe"),
    transport: () => ({
      async send(envelope) {
        const data = serialize(envelope);
        if (!replay && envelope[1].some(([header]) => header.type === "event"))
          replay = data;
        const response = await fetch(ingest, {
          method: "POST",
          headers: { "content-type": "application/x-sentry-envelope" },
          body: data,
        });
        return { statusCode: response.status };
      },
      async flush() {
        return true;
      },
    }),
  });
  function firstError() {
    return new TypeError("first failure");
  }
  function secondError() {
    return new RangeError("second failure");
  }
  for (let i = 0; i < 3; i++) Sentry.captureException(firstError());
  Sentry.captureException(secondError());
  Sentry.captureMessage("fixture message");
  assert.equal(await Sentry.flush(10000), true);
  const headers = { authorization: `Bearer ${token}` };
  async function api(path, init = {}) {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
    assert.equal(
      response.status,
      200,
      `API ${path}: ${await response.clone().text()}`,
    );
    return response.json();
  }
  const base = "/api/0/projects/default/default";
  let issues = await waitFor(async () => {
    const rows = await api(`${base}/issues/`);
    return rows.length === 3 && rows.some((x) => Number(x.count) === 3)
      ? rows
      : null;
  }, "three grouped issues");
  const first = issues.find((x) => x.title.includes("first failure"));
  const second = issues.find((x) => x.title.includes("second failure"));
  const message = issues.find((x) => x.title.includes("fixture message"));
  assert.ok(first && second && message);
  assert.equal(first.count, "3");
  assert.equal(second.count, "1");
  assert.equal(message.count, "1");
  const events = await api(`/api/0/issues/${first.id}/events/`);
  assert.equal(events.length, 3);
  const latest = await api(`/api/0/issues/${first.id}/events/latest/`);
  const event = await api(`${base}/events/${latest.eventID}/`);
  assert.equal(event.eventID, latest.eventID);
  const originalCounts = issues.map((issue) => [issue.id, issue.count]).sort();
  assert.ok(replay);
  assert.equal(
    (await fetch(ingest, { method: "POST", body: replay })).status,
    200,
  );
  await waitFor(
    async () =>
      (await createBlobs({ root: join(directory, "blobs") }).list("envelopes/"))
        .items.length === 0,
    "duplicate processing",
  );
  issues = await api(`${base}/issues/`);
  assert.deepEqual(
    issues.map((issue) => [issue.id, issue.count]).sort(),
    originalCounts,
  );
  await api(`/api/0/issues/${first.id}/`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "resolved" }),
  });
  await delay(10);
  Sentry.captureException(firstError());
  assert.equal(await Sentry.flush(10000), true);
  const reopened = await waitFor(async () => {
    const issue = await api(`/api/0/issues/${first.id}/`);
    return issue.count === "4" && issue.status === "unresolved" ? issue : null;
  }, "regression");
  assert.equal(reopened.status, "unresolved");
} finally {
  await Sentry.close(2000);
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    const exited = new Promise((resolveExit) =>
      child.once("exit", () => resolveExit(true)),
    );
    const stopped = await Promise.race([exited, delay(5000).then(() => false)]);
    if (!stopped) {
      child.kill("SIGKILL");
      await exited;
      shutdownFailure = "Standalone server did not stop after SIGTERM";
    }
    if (child.exitCode !== 0) shutdownFailure ??= "Standalone shutdown failed";
  }
  await rm(directory, { recursive: true, force: true });
}

if (shutdownFailure) throw new Error(shutdownFailure);
console.log(
  "PASS: 3 issues; exception counts 3 and 1; message, event retrieval, duplicate replay and regression verified",
);
