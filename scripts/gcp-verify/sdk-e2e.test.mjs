import { describe, expect, it } from "vitest";
import { buildEnvelope, probe, uniqueError } from "./sdk-e2e.mjs";
import {
  dataOf,
  PROJECT,
  REGION,
  routerFetch,
  testContext,
} from "./testing.mjs";

const KEY = "k".repeat(32);
const TOKEN = "api-token-value";

/** An in-memory Sentry-compatible backend: ingest, a few API routes and the bootstrap secret. */
function backend({ dedupe = true, regress = true } = {}) {
  const issues = new Map();
  const seen = new Set();
  const record = (id, title) => {
    if (dedupe && seen.has(id)) return;
    seen.add(id);
    const issue = issues.get(title) ?? {
      id: String(issues.size + 1),
      title,
      count: 0,
      status: "unresolved",
    };
    issue.count += 1;
    if (issue.status === "resolved" && regress) issue.status = "unresolved";
    issues.set(title, issue);
  };
  const render = (issue) => ({ ...issue, count: String(issue.count) });
  const authorized = (init) =>
    init.headers?.authorization === `Bearer ${TOKEN}`;
  const fetch = routerFetch([
    [
      "GET",
      /secretmanager\.googleapis\.com.*versions\/latest:access/,
      () => ({
        body: {
          payload: {
            data: dataOf({ dsn: `https://${KEY}@ingest.test/7`, token: TOKEN }),
          },
        },
      }),
    ],
    [
      "POST",
      /ingest\.test\/api\/7\/envelope\/(\?sentry_key=(\w+))?$/,
      (_url, init, match) => {
        if (match[2] !== KEY) return { status: 401, body: {} };
        const [head, , payload] = String(init.body).split("\n");
        const event = JSON.parse(payload);
        record(JSON.parse(head).event_id, event.message);
        return { body: {} };
      },
    ],
    [
      "GET",
      /api\.test\/api\/0\/projects\/default\/default\/issues\//,
      (_url, init) =>
        authorized(init)
          ? { body: [...issues.values()].map(render) }
          : { status: 401 },
    ],
    [
      "GET",
      /api\.test\/api\/0\/issues\/(\d+)\/events\/latest\//,
      () => ({ body: { eventID: "e".repeat(32) } }),
    ],
    [
      "GET",
      /api\.test\/api\/0\/issues\/(\d+)\/$/,
      (_url, init, match) => {
        const issue = [...issues.values()].find((item) => item.id === match[1]);
        return authorized(init) && issue
          ? { body: render(issue) }
          : { status: 404 };
      },
    ],
    [
      "PUT",
      /api\.test\/api\/0\/issues\/(\d+)\/$/,
      (_url, init, match) => {
        const issue = [...issues.values()].find((item) => item.id === match[1]);
        issue.status = JSON.parse(init.body).status;
        return { body: render(issue) };
      },
    ],
  ]);
  let nextId = 0;
  // A fake SDK: exceptions group by their error name, messages by text.
  const sentry = async () => {
    const send = (title) =>
      fetch(`https://ingest.test/api/7/envelope/?sentry_key=${KEY}`, {
        method: "POST",
        body: buildEnvelope(
          `${(nextId++).toString(16).padStart(32, "0")}`,
          title,
        ),
      });
    const pending = [];
    return {
      captureException: (error) =>
        pending.push(
          send(`${error.name}: ${error.message}`.replace(/ \d+$/, "")),
        ),
      captureMessage: (text) => pending.push(send(text)),
      flush: async () => {
        await Promise.all(pending);
        return true;
      },
      close: async () => true,
    };
  };
  return { fetch, sentry, issues };
}

const options = {
  outputs: { ingest_url: "https://ingest.test", api_url: "https://api.test" },
};

describe("sdk probe", () => {
  it("passes against a correct backend and scrubs the output", async () => {
    const world = backend();
    const { ctx, output } = await testContext({
      fetch: world.fetch,
      ...options,
      deps: { sentry: world.sentry },
    });
    await probe.run(ctx);
    expect(ctx.report.summary()).toMatchObject({ fail: 0 });
    expect(ctx.report.summary().pass).toBeGreaterThanOrEqual(8);
    for (const forbidden of [PROJECT, REGION, TOKEN, KEY, "ingest.test"])
      expect(output()).not.toContain(forbidden);
  });
  it("fails the duplicate check when the backend counts a replay twice", async () => {
    const world = backend({ dedupe: false });
    const { ctx, output } = await testContext({
      fetch: world.fetch,
      ...options,
      deps: { sentry: world.sentry },
    });
    await probe.run(ctx);
    expect(output()).toContain("FAIL a duplicate envelope is counted once");
  });
  it("fails when a resolved issue does not reopen", async () => {
    const world = backend({ regress: false });
    const { ctx, output } = await testContext({
      fetch: world.fetch,
      ...options,
      deps: { sentry: world.sentry },
    });
    await probe.run(ctx);
    expect(output()).toContain(
      "FAIL a new event after resolve reopens the issue",
    );
  });
  it("builds unique error names and a parsable envelope", () => {
    expect(uniqueError("G8x", "Alpha", 2).name).toBe("G8xAlphaError");
    const lines = buildEnvelope("a".repeat(32), "hello")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0].event_id).toBe("a".repeat(32));
    expect(lines[1]).toEqual({ type: "event" });
    expect(lines[2].message).toBe("hello");
  });
});
