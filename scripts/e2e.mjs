import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { create as createBlobs } from "@errtraq/blob-fs";
import { parseEnvelope } from "@errtraq/core";
import * as Sentry from "@sentry/node";

const root = resolve(".agents-workspace/tmp");
await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, "m1g-e2e-"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let child,
  output = "",
  errors = "",
  proxy,
  proxyError,
  replay,
  sessionSeen = false;
async function waitFor(fn, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error(`server exited during ${label}: ${errors}`);
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`timed out: ${label}: ${errors}`);
}
async function start() {
  output = "";
  errors = "";
  child = spawn(
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
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    errors += chunk;
  });
  await waitFor(
    () => output.includes("Listening:") && output.includes("API token:"),
    "startup",
  );
  const dsn = output.match(/^DSN: (.+)$/m)?.[1],
    token = output.match(/^API token: (.+)$/m)?.[1],
    origin = output.match(/^Listening: (.+)$/m)?.[1];
  assert.ok(dsn && token && origin);
  return { dsn, token, origin };
}
async function stop(signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((resolveExit) =>
    child.once("exit", (code, sig) => resolveExit({ code, sig })),
  );
  child.kill(signal);
  const result = await withTimeout(exit, 8000, null);
  if (!result) {
    child.kill("SIGKILL");
    await exit;
    throw new Error("server failed to stop");
  }
  if (signal === "SIGTERM") assert.equal(result.code, 0, "graceful shutdown");
}
try {
  let server = await start();
  const parsed = new URL(server.dsn);
  assert.equal(parsed.hostname, new URL(server.origin).hostname);
  assert.equal(parsed.hostname, "127.0.0.1");
  proxy = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const decoded =
        req.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes;
      const envelope = parseEnvelope(decoded);
      if (envelope.items.some((item) => item.headers.type === "session"))
        sessionSeen = true;
      if (
        !replay &&
        envelope.items.some((item) => item.headers.type === "event")
      )
        replay = {
          bytes,
          encoding: req.headers["content-encoding"],
          url: req.url,
        };
      const target = new URL(req.url, server.origin);
      const outgoing = httpRequest(
        target,
        { method: req.method, headers: { ...req.headers, host: target.host } },
        (response) => {
          res.writeHead(response.statusCode ?? 500, response.headers);
          response.pipe(res);
        },
      );
      outgoing.on("error", (error) => {
        proxyError = error;
        res.statusCode = 500;
        res.end();
      });
      outgoing.end(bytes);
    } catch (error) {
      proxyError = error;
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise((resolveListen, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolveListen);
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const sdkDsn = `http://${parsed.username}@127.0.0.1:${address.port}${parsed.pathname}`;
  Sentry.init({
    dsn: sdkDsn,
    maxValueLength: 500000,
    release: "fixture-release",
  });
  function firstError(index) {
    return new TypeError(`first failure ${index}`);
  }
  function secondError() {
    return new RangeError("second failure");
  }
  for (let i = 0; i < 3; i++) Sentry.captureException(firstError(i));
  Sentry.captureException(secondError());
  Sentry.captureMessage("fixture message");
  const huge = "x".repeat(220000);
  Sentry.withScope((scope) => {
    scope.setExtra("large", huge);
    Sentry.captureMessage("large payload");
  });
  Sentry.startSession();
  Sentry.captureSession();
  assert.equal(await Sentry.flush(15000), true);
  if (proxyError) throw proxyError;
  const headers = { authorization: `Bearer ${server.token}` };
  async function rawApi(path, init = {}) {
    return fetch(`${server.origin}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
  }
  async function api(path, init = {}) {
    const response = await rawApi(path, init);
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
    return rows.length === 4 && rows.some((x) => Number(x.count) === 3)
      ? rows
      : null;
  }, "issues");
  const first = issues.find((x) => x.title.includes("first failure")),
    second = issues.find((x) => x.title.includes("second failure")),
    message = issues.find((x) => x.title.includes("fixture message")),
    large = issues.find((x) => x.title.includes("large payload"));
  assert.ok(first && second && message && large);
  assert.equal(first.count, "3");
  assert.equal(second.count, "1");
  assert.equal(message.count, "1");
  assert.ok(sessionSeen, "default transport sent session");
  const events = await api(`/api/0/issues/${first.id}/events/`);
  assert.equal(events.length, 3);
  const latest = await api(`/api/0/issues/${first.id}/events/latest/`);
  assert.equal(
    (await api(`${base}/events/${latest.eventID}/`)).eventID,
    latest.eventID,
  );
  const largeEvent = await api(`/api/0/issues/${large.id}/events/latest/`);
  assert.equal(largeEvent.extra.large, huge);
  assert.equal((await fetch(`${server.origin}${base}/issues/`)).status, 401);
  let cursor = "",
    paged = [];
  do {
    const response = await rawApi(
      `${base}/issues/?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
    );
    assert.equal(response.status, 200);
    paged.push(...(await response.json()));
    cursor =
      response.headers
        .get("link")
        ?.match(/rel="next"; results="true"; cursor="([^"]+)"/)?.[1] ?? "";
  } while (cursor);
  assert.equal(new Set(paged.map((x) => x.id)).size, 4);
  const counts = issues.map((x) => [x.id, x.count]).sort();
  assert.ok(replay);
  const raw =
    replay.encoding === "gzip" ? gunzipSync(replay.bytes) : replay.bytes;
  assert.equal(
    (
      await fetch(`${server.origin}${replay.url}`, {
        method: "POST",
        headers: { "content-encoding": "gzip" },
        body: gzipSync(raw),
      })
    ).status,
    200,
  );
  await waitFor(
    async () =>
      (await createBlobs({ root: join(directory, "blobs") }).list("envelopes/"))
        .items.length === 0,
    "duplicate processing",
  );
  issues = await api(`${base}/issues/`);
  assert.deepEqual(issues.map((x) => [x.id, x.count]).sort(), counts);
  await api(`/api/0/issues/${first.id}/`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "resolved" }),
  });
  await delay(20);
  Sentry.captureException(firstError(4));
  assert.equal(await Sentry.flush(10000), true);
  await waitFor(async () => {
    const issue = await api(`/api/0/issues/${first.id}/`);
    return issue.count === "4" && issue.status === "unresolved";
  }, "regression");
  await Sentry.close(2000);
  await new Promise((resolveClose) => proxy.close(resolveClose));
  proxy = undefined;
  const token = server.token;
  const dsnForBurst = new URL(server.dsn);
  const burstUrl = `${server.origin}/api/${dsnForBurst.pathname.slice(1)}/envelope/?sentry_key=${dsnForBurst.username}`;
  const burst = await Promise.all(
    Array.from({ length: 20 }, (_, i) => {
      const eventId = (1000 + i).toString(16).padStart(32, "0");
      return fetch(burstUrl, {
        method: "POST",
        body: `{"event_id":"${eventId}"}\n{"type":"event"}\n{"event_id":"${eventId}","message":"shutdown burst"}\n`,
      });
    }),
  );
  assert.ok(burst.every((response) => response.status === 200));
  await stop();
  server = await start();
  assert.equal(server.token, token);
  issues = await api(`${base}/issues/`);
  assert.equal(issues.find((x) => x.id === first.id).count, "4");
  assert.equal(issues.find((x) => x.id === second.id).count, "1");
  await waitFor(
    async () =>
      (await api(`${base}/issues/`)).find((x) => x.title === "shutdown burst")
        ?.count === "20",
    "shutdown burst drain",
  );
  const oldKey = new URL(server.dsn);
  const eventId = "1234567890abcdef1234567890abcdef";
  const staged = `envelopes/${oldKey.pathname.slice(1)}/${encodeURIComponent(new Date().toISOString())}/${eventId}/crash-test`;
  const payload = Buffer.from(
    `{"event_id":"${eventId}"}\n{"type":"event"}\n{"event_id":"${eventId}","message":"recovered event"}\n`,
  );
  await createBlobs({ root: join(directory, "blobs") }).put(staged, payload);
  await stop("SIGKILL");
  server = await start();
  assert.equal(server.token, token);
  await waitFor(
    async () =>
      (await api(`${base}/issues/`)).some((x) => x.title === "recovered event"),
    "staged recovery",
  );
  assert.equal(
    (await api(`${base}/issues/`)).find((x) => x.title === "recovered event")
      .count,
    "1",
  );
  // A partial request must not prevent shutdown past the connection deadline.
  const address2 = new URL(server.origin);
  const socket = connect(Number(address2.port), "127.0.0.1");
  await new Promise((resolveConnect) => socket.once("connect", resolveConnect));
  socket.write(
    "POST /api/1/envelope/ HTTP/1.1\r\nHost: localhost\r\nContent-Length: 999\r\n\r\nx",
  );
  await delay(50);
  await stop();
  socket.destroy();
  const rotation = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "packages/cli/dist/bin.js",
      "token",
      "rotate",
      "--stack",
      "stacks/local.ts",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ERRTRAQ_DATA_DIR: directory, ERRTRAQ_PORT: "0" },
    },
  );
  assert.equal(rotation.status, 0, rotation.stderr);
  const replacement = rotation.stdout.match(/^API token: (.+)$/m)?.[1];
  assert.ok(replacement && replacement !== token);
  server = await start();
  assert.equal(server.token, replacement);
  assert.equal(
    (
      await fetch(`${server.origin}${base}/issues/`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${server.origin}${base}/issues/`, {
        headers: { authorization: `Bearer ${replacement}` },
      })
    ).status,
    200,
  );
  const address3 = new URL(server.origin);
  const socket2 = connect(Number(address3.port), "127.0.0.1");
  await new Promise((resolveConnect) =>
    socket2.once("connect", resolveConnect),
  );
  socket2.write(
    "POST /api/1/envelope/ HTTP/1.1\r\nHost: localhost\r\nContent-Length: 999\r\n\r\nx",
  );
  await delay(50);
  const secondExit = new Promise((resolveExit) =>
    child.once("exit", (_code, signal) => resolveExit(signal)),
  );
  child.kill("SIGTERM");
  await delay(100);
  const began = Date.now();
  child.kill("SIGTERM");
  assert.equal(await withTimeout(secondExit, 2000, "timeout"), "SIGTERM");
  assert.ok(Date.now() - began < 2000);
  socket2.destroy();
  console.log(
    "PASS: default SDK transport and session, gzip replay, overflow, paging, auth, regression, restart persistence, token rotation, burst drain, staged recovery and bounded shutdown",
  );
} finally {
  await Sentry.close(2000);
  if (proxy) await new Promise((resolveClose) => proxy.close(resolveClose));
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
  await rm(directory, { recursive: true, force: true });
}
