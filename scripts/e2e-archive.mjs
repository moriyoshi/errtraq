// Opt-in archive end-to-end (M4g). Needs the local archive stack (see docker/archive and the header
// of packages/adapters/archive-iceberg/src/duckdb/lakekeeper.opt-in.test.ts):
//
//   ERRTRAQ_LAKEKEEPER_URL=http://127.0.0.1:18181/catalog pnpm e2e:archive
//
// It runs `errtraq migrate` (active store and the Iceberg table), seeds events (some older than
// the project's hot-tier age), starts `errtraq dev` with stacks/local-archive.ts (planner timer
// every 5 s), waits for the archival, asserts the rows in Iceberg through a separate DuckDB
// session against Lakekeeper, and pages the events API across the watermark (gapless,
// duplicate-free, ordered), both while the DELETE step may still be pending and after it.
// Skips (exit 0) when ERRTRAQ_LAKEKEEPER_URL or @duckdb/node-api is missing.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bootstrapProject, WebCryptoIdGen } from "@moriyoshi/errtraq-core";
import { create as createSqlite } from "@moriyoshi/errtraq-store-sql";

const uri = process.env.ERRTRAQ_LAKEKEEPER_URL;
// @duckdb/node-api is a dependency of archive-iceberg only; importing the engine subpath loads it.
const engine = await import("@moriyoshi/errtraq-archive-iceberg/duckdb").catch(
  () => undefined,
);
if (!uri || !engine) {
  console.log(
    `SKIP archive e2e: ${!uri ? "ERRTRAQ_LAKEKEEPER_URL is not set" : "@duckdb/node-api is not available"}.`,
  );
  process.exit(0);
}
const { openDuckDbSession } = engine;
const { configSchema } = await import(
  "@moriyoshi/errtraq-archive-iceberg/stack"
);

const bin = resolve("packages/cli/dist/bin.js");
const stackFile = resolve("stacks/local-archive.ts");
const scratch = resolve(".agents-workspace/tmp");
await mkdir(scratch, { recursive: true });
const directory = await mkdtemp(join(scratch, "m4g-e2e-"));
const namespace = "errtraq";
const environment = {
  ...process.env,
  ERRTRAQ_DATA_DIR: directory,
  ERRTRAQ_PORT: "0",
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "test",
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Migrate (own process: exercises the CLI command and the table bootstrap).
const migrated = spawnSync(
  process.execPath,
  [bin, "migrate", "--stack", stackFile],
  { env: environment, encoding: "utf8" },
);
assert.equal(migrated.status, 0, `migrate failed: ${migrated.stderr}`);
assert.match(migrated.stdout, /Active store migrated/);
assert.match(migrated.stdout, /Archive table (created|already exists)/);
console.log(`migrate: ${migrated.stdout.trim().replaceAll("\n", "; ")}`);

// 2. Seed events: OLD older than the hot-tier age (30 days), RECENT inside it. Equal receivedAt
//    values exercise the (receivedAt, eventId) tie-break.
// The table outlives a run, so everything this run seeds carries a unique tag.
const tag = Math.random().toString(16).slice(2, 10).padStart(8, "0");
const issueId = `issue-${tag}`;
const OLD = 40;
const RECENT = 20;
const store = createSqlite({
  config: { path: join(directory, "events.sqlite") },
});
await store.migrate();
const kv = (() => {
  const m = new Map();
  return {
    async increment(key, by) {
      const v = Number(m.get(key) ?? 0) + by;
      m.set(key, String(v));
      return v;
    },
    get: async (key) => m.get(key) ?? null,
    put: async (key, value) => void m.set(key, value),
    delete: async (key) => void m.delete(key),
  };
})();
const boot = await bootstrapProject({
  store,
  kv,
  ids: new WebCryptoIdGen(),
  orgSlug: "default",
  projectSlug: "default",
});
const projectId = boot.project.id;
const day = 24 * 3600 * 1000;
const expected = [];
for (let n = 0; n < OLD + RECENT; n++) {
  const old = n < OLD;
  const base = old ? Date.now() - 400 * day : Date.now() - 60 * 1000;
  const receivedAt = new Date(base + Math.floor(n / 2) * 1000).toISOString();
  const eventId = `${tag}${String(n).padStart(24, "0")}`;
  expected.push({ eventId, receivedAt, old });
  const fields = {
    projectId,
    issueId,
    eventId,
    receivedAt,
    timestamp: receivedAt,
  };
  await store.recordEvent(
    {
      ...fields,
      fingerprint: "fp-e2e",
      title: "e2e error",
      culprit: "e2e",
      type: "Error",
      metadata: {},
      level: "error",
    },
    { ...fields, level: "error", tags: {}, payload: { message: `event ${n}` } },
  );
}
await store.close();
expected.sort(
  (a, b) =>
    b.receivedAt.localeCompare(a.receivedAt) ||
    b.eventId.localeCompare(a.eventId),
);

// 3. Start the standalone process.
let output = "";
const child = spawn(process.execPath, [bin, "dev", "--stack", stackFile], {
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (c) => (output += c));
child.stderr.on("data", (c) => (output += c));
async function waitFor(fn, label, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`server exited during ${label}: ${output}`);
    const value = await fn().catch(() => undefined);
    if (value) return value;
    await delay(250);
  }
  throw new Error(`timed out: ${label}: ${output}`);
}
let failed = false;
try {
  const base = await waitFor(async () => {
    const m = /Listening: (http:\/\/\S+)/.exec(output);
    return m?.[1];
  }, "server start");
  const token = /API token: (\S+)/.exec(output)?.[1];
  assert.ok(token, "API token not printed");
  const headers = { authorization: `Bearer ${token}` };

  // 4. A separate DuckDB session reads the Iceberg table through Lakekeeper.
  const parsed = configSchema.parse({
    catalog: {
      uri,
      warehouse: process.env.ERRTRAQ_LAKEKEEPER_WAREHOUSE ?? "errtraq",
    },
    namespace,
    engine: {
      homeDirectory: join(directory, "duckdb-verify"),
      s3: {
        endpoint: process.env.ERRTRAQ_ARCHIVE_S3_ENDPOINT ?? "127.0.0.1:15555",
        urlStyle: "path",
        useSsl: false,
        region: "us-east-1",
      },
    },
  });
  const session = await openDuckDbSession({
    catalog: parsed.catalog,
    engine: parsed.engine,
    credentials: async () => ({ accessKeyId: "test", secretAccessKey: "test" }),
    region: "us-east-1",
  });
  try {
    const rows = await waitFor(async () => {
      const [r] = await session.all(
        `SELECT count(*) AS n FROM lake."${namespace}".events WHERE issue_id = ?`,
        [issueId],
      );
      return Number(r?.n) >= OLD ? r : undefined;
    }, "archived rows in Iceberg");
    const [stats] = await session.all(
      `SELECT count(*) AS n, count(DISTINCT event_id) AS d, count(DISTINCT archive_batch) AS b, min(received_at)::VARCHAR AS lo, max(received_at)::VARCHAR AS hi FROM lake."${namespace}".events WHERE issue_id = ?`,
      [issueId],
    );
    assert.equal(
      Number(stats.n),
      OLD,
      `rows in Iceberg: ${JSON.stringify(rows)}`,
    );
    assert.equal(Number(stats.d), OLD, "duplicate event ids in Iceberg");
    const ids = await session.all(
      `SELECT event_id FROM lake."${namespace}".events WHERE issue_id = ? ORDER BY event_id`,
      [issueId],
    );
    assert.deepEqual(
      ids.map((r) => r.event_id),
      expected
        .filter((e) => e.old)
        .map((e) => e.eventId)
        .sort(),
    );
    console.log(
      `iceberg: ${stats.n} rows, ${stats.d} distinct, ${stats.b} batch(es)`,
    );
  } finally {
    session.close();
  }

  // 5. Page the API across the watermark, now and after the DELETE step settled.
  async function pageAll(limit) {
    const ids = [];
    let cursor;
    for (let guard = 0; guard < 200; guard++) {
      const response = await fetch(
        `${base}/api/0/issues/${issueId}/events/?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
        { headers },
      );
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      ids.push(...body.map((e) => e.eventID));
      cursor = /rel="next"; results="true"; cursor="([^"]+)"/.exec(
        response.headers.get("link") ?? "",
      )?.[1];
      if (!cursor) return ids;
    }
    throw new Error("paging did not terminate");
  }
  const want = expected.map((e) => e.eventId);
  for (const limit of [1, 7, 25, 100]) {
    const got = await pageAll(limit);
    assert.deepEqual(got, want, `page sequence with limit ${limit}`);
  }
  console.log(
    `api: ${want.length} events gapless, duplicate-free, ordered (before settle)`,
  );
  await delay(8000); // two planner ticks: the DELETE step and a no-op re-run have finished
  for (const limit of [3, 50]) {
    assert.deepEqual(await pageAll(limit), want, `settled, limit ${limit}`);
  }
  const archivedId = expected.find((e) => e.old)?.eventId;
  const detail = await fetch(
    `${base}/api/0/projects/default/default/events/${archivedId}/`,
    { headers },
  );
  assert.equal(detail.status, 200, "archived event detail");
  console.log("api: settled pages and an archived event detail are correct");
  console.log("PASS: archive end-to-end");
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.stack : String(error));
} finally {
  child.kill("SIGTERM");
  await new Promise((r) => {
    child.once("exit", r);
    setTimeout(r, 5000);
  });
}
process.exit(failed ? 1 : 0);
