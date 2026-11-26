// M4d smoke: brings up the local archive stack (Postgres, Lakekeeper, winterbaume, DuckDB runner)
// in Docker, bootstraps Lakekeeper, runs the spike, prints PASS/FAIL per question and tears the
// stack down (compose down -v). Opt-in; NOT part of `pnpm test`. Nothing is installed on the host.
//
//   pnpm archive:smoke
//   WINTERBAUME_LINUX_BINARY=/abs/path/winterbaume-server pnpm archive:smoke
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compose = resolve(root, "docker/archive/compose.yaml");
const project = "errtraq-archive-smoke";
const version = "0.2.10";

function skip(message) {
  console.log(`SKIP archive smoke: ${message}`);
  process.exit(0);
}

const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
  encoding: "utf8",
});
if (info.error || info.status !== 0)
  skip("Docker is not available (is the daemon running?).");
if (
  spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status !== 0
)
  skip("the `docker compose` plugin is not available.");

const triple =
  arch() === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
const platform = arch() === "arm64" ? "linux/arm64" : "linux/amd64";
const candidates = [
  process.env.WINTERBAUME_LINUX_BINARY,
  resolve(
    root,
    `.agents-workspace/tmp/winterbaume-server-v${version}/bin-linux/winterbaume-server-${triple}/winterbaume-server`,
  ),
  resolve(
    root,
    `../../../.agents-workspace/tmp/winterbaume-server-v${version}/bin-linux/winterbaume-server-${triple}/winterbaume-server`,
  ),
].filter(Boolean);
const binary = candidates.find((candidate) => existsSync(candidate));
if (!binary)
  skip(
    `no linux winterbaume-server ${version} binary (${triple}). Download and checksum-verify the release archive, extract it, and set WINTERBAUME_LINUX_BINARY=<path to winterbaume-server>.`,
  );

const env = {
  ...process.env,
  WINTERBAUME_BINARY: binary,
  ARCHIVE_PLATFORM: platform,
};
const dc = (args, options = {}) =>
  spawnSync("docker", ["compose", "-p", project, "-f", compose, ...args], {
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });

let tornDown = false;
function teardown() {
  if (tornDown) return;
  tornDown = true;
  const down = dc(["down", "-v", "--remove-orphans", "--timeout", "5"]);
  console.log(
    `teardown: compose down -v ${down.status === 0 ? "ok" : `FAILED\n${down.stderr}`}`,
  );
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    teardown();
    process.exit(130);
  });

function exec(script) {
  return new Promise((done) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "-p",
        project,
        "-f",
        compose,
        "exec",
        "-T",
        "runner",
        "node",
        script,
      ],
      { env },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(
        d
          .toString()
          .split("\n")
          .filter((l) => l.startsWith("NOTE "))
          .map((l) => `  ${l.slice(0, 400)}\n`)
          .join(""),
      );
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => done({ code, out, err }));
  });
}

let exitCode = 1;
try {
  console.log(`archive smoke: platform ${platform}, winterbaume ${binary}`);
  const up = dc(["up", "-d", "--build", "--wait"]);
  if (up.status !== 0)
    throw new Error(`compose up failed:\n${up.stdout}\n${up.stderr}`);
  console.log(
    "stack is up (db, winterbaume, lakekeeper migrate+serve, runner)",
  );

  const boot = await exec("bootstrap.mjs");
  const bootJson = boot.out.trim().split("\n").at(-1);
  let parsed;
  try {
    parsed = JSON.parse(bootJson);
  } catch {
    throw new Error(`bootstrap produced no JSON:\n${boot.out}\n${boot.err}`);
  }
  console.log(
    `bootstrap: bucket ${parsed.bucket.status}, lakekeeper bootstrap ${parsed.bootstrap.status}, warehouse ${parsed.warehouse.status}`,
  );
  const spike = parsed.ok
    ? await exec("spike.mjs")
    : { out: "", err: JSON.stringify(parsed.warehouse.body) };
  if (!parsed.ok) {
    console.log(
      `Q1 FAIL warehouse creation rejected: ${JSON.stringify(parsed.warehouse.body)}`,
    );
    console.log("   D11 fallback: see .agents-docs/M4D_LOCAL_ARCHIVE_SPIKE.md");
  }

  const results = spike.out
    .split("\n")
    .filter((line) => line.startsWith("RESULT "))
    .map((line) => JSON.parse(line.slice(7)));
  if (parsed.ok && !spike.out.includes("SPIKE_DONE"))
    console.log(`spike did not finish:\n${spike.err}`);

  // winterbaume request log summary (multipart / range / error traffic).
  const logs = stripVTControlCharacters(
    dc(["logs", "winterbaume", "--no-log-prefix"]).stdout,
  );
  const reqs = logs.split("\n").filter((line) => line.includes("method="));
  const count = (re) => reqs.filter((line) => re.test(line)).length;
  const statuses = {};
  for (const line of reqs) {
    const status = /status=(\d+)/.exec(line)?.[1] ?? "?";
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  console.log(
    `winterbaume traffic: ${reqs.length} requests, multipart initiate ${count(/method=POST.*[?&]uploads=/)}, part PUTs ${count(/partNumber=/)}, complete ${count(/method=POST.*uploadId=/)}, statuses ${JSON.stringify(statuses)}`,
  );
  const serverErrors = reqs.filter((line) => /status=5\d\d/.test(line));
  const q5 = results.filter((r) => r.question === "Q5");
  q5.push({
    question: "Q5",
    name: "winterbaume served no 5xx responses",
    pass: serverErrors.length === 0,
    known: false,
    detail: serverErrors[0] ?? "",
  });
  results.push(q5.at(-1));

  const titles = {
    Q1: "Lakekeeper warehouse creation + storage validation against winterbaume",
    Q2: "DuckDB ATTACH, CREATE (v3/v2), INSERT, DELETE (deletion vectors), read back",
    Q3: "Lakekeeper format-version policy allows v3",
    Q4: "Lakekeeper maintenance task queues in the open-source image",
    Q5: "winterbaume under multipart and range traffic",
    Q6: "M4b operations (archive_batch probe, batchEventIds, day pruning, sort order)",
  };
  let failed = false;
  console.log("\n=== results ===");
  for (const id of Object.keys(titles)) {
    const rows = results.filter((r) => r.question === id);
    const bad = rows.filter((r) => !r.pass && !r.known);
    const knownNo = rows.filter((r) => !r.pass && r.known);
    const verdict =
      rows.length === 0
        ? "FAIL"
        : bad.length
          ? "FAIL"
          : knownNo.length
            ? "NO (documented limitation)"
            : "PASS";
    if (verdict === "FAIL") failed = true;
    console.log(`${verdict.padEnd(5)} ${id} ${titles[id]}`);
    for (const r of rows)
      console.log(
        `        ${r.pass ? "ok  " : r.known ? "no  " : "FAIL"} ${r.name}${r.pass ? "" : `: ${r.detail.replace(/\s+/g, " ").slice(0, 300)}`}`,
      );
  }
  exitCode = failed ? 1 : 0;
  console.log(failed ? "\nSMOKE FAIL" : "\nSMOKE PASS");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
} finally {
  teardown();
}
process.exit(exitCode);
