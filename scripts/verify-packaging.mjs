import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { packageFiles } from "./version.mjs";

// Opt-in check (`pnpm verify:packaging`): pack every public package, install the tarballs into a
// throwaway project without a workspace file and drive the installed CLI. Not part of `pnpm test`.
const repo = process.cwd();
const work = resolve(".agents-workspace/tmp/pack");
const project = join(work, "project");
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  return ok;
}
function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}
function skip(reason) {
  console.log(`SKIP packaging check: ${reason}`);
  process.exit(0);
}
const tail = (text) => text.trim().split("\n").slice(-6).join("\n");
function step(name, result) {
  return record(
    name,
    result.status === 0,
    result.status === 0 ? "" : tail(`${result.stdout}\n${result.stderr}`),
  );
}
async function files(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}

if (run("npm", ["--version"]).status !== 0) skip("npm is not available");
const hasTerraform = run("terraform", ["version"]).status === 0;
if (
  run("npm", ["ping", "--fetch-retries=0", "--fetch-timeout=10000"]).status !==
  0
)
  skip("the npm registry is unreachable");

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });

const tarballs = [];
for (const file of await packageFiles(repo)) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (manifest.private) continue;
  const directory = file.slice(0, -"/package.json".length);
  const packed = run("pnpm", ["pack", "--pack-destination", work], {
    cwd: directory,
  });
  if (!step(`pack ${manifest.name}`, packed)) continue;
  const name = packed.stdout.trim().split("\n").pop() ?? "";
  tarballs.push({ manifest, file: resolve(work, name.split("/").pop() ?? "") });
}

const local = [repo, homedir()].filter((path) => path.length > 1);
for (const { manifest, file } of tarballs) {
  const listing = run("tar", ["-tzf", file]).stdout.split("\n").filter(Boolean);
  const problems = [];
  const expected =
    manifest.name === "@moriyoshi/errtraq-terraform-modules"
      ? "package/aws/"
      : "package/dist/";
  if (!listing.some((entry) => entry.startsWith(expected)))
    problems.push(`no ${expected}**`);
  for (const entry of listing)
    if (
      /^package\/src\//.test(entry) ||
      /\.test\./.test(entry) ||
      /tftest|\/tests\//.test(entry)
    )
      problems.push(`unexpected ${entry}`);
  const contents = run("tar", ["-xOzf", file], {
    maxBuffer: 512 * 1024 * 1024,
  }).stdout;
  for (const path of local)
    if (contents.includes(path))
      problems.push(
        `contains ${path === repo ? "the repository path" : "the home directory"}`,
      );
  const packedManifest = run("tar", [
    "-xOzf",
    file,
    "package/package.json",
  ]).stdout;
  if (/"development"/.test(packedManifest))
    problems.push("development condition in package.json");
  if (/workspace:/.test(packedManifest))
    problems.push("workspace: specifier in package.json");
  record(
    `inspect ${manifest.name}`,
    problems.length === 0,
    problems.slice(0, 3).join("; "),
  );
}

await mkdir(join(project, "stacks"), { recursive: true });
await writeFile(
  join(project, "package.json"),
  `${JSON.stringify({ name: "errtraq-packaging-check", private: true, type: "module" }, null, 2)}\n`,
);
for (const stack of ["local", "aws-dynamodb"])
  await cp(`stacks/${stack}.ts`, join(project, `stacks/${stack}.ts`));
const install = run(
  "npm",
  [
    "install",
    "--no-audit",
    "--no-fund",
    "--no-package-lock",
    ...tarballs.map(({ file }) => file),
  ],
  { cwd: project },
);
if (!step("npm install of the tarballs", install)) finish();

const cli = join(project, "node_modules/.bin/errtraq");
// The throwaway project sits inside this repository's directory tree, so name the root explicitly.
const errtraq = (...args) => run(cli, args, { cwd: project });
const rootArgs = ["--root", project];
for (const stack of ["local", "aws-dynamodb"]) {
  step(
    `validate ${stack}`,
    errtraq("validate", "--stack", `stacks/${stack}.ts`),
  );
  step(
    `build ${stack}`,
    errtraq("build", "--stack", `stacks/${stack}.ts`, ...rootArgs),
  );
}
const generated = errtraq(
  "infra",
  "generate",
  "--stack",
  "stacks/aws-dynamodb.ts",
  ...rootArgs,
);
const generatedOk = step("infra generate (vendor)", generated);
const root = join(project, "infra/generated/aws-dynamodb");
if (generatedOk) {
  const main = JSON.parse(await readFile(join(root, "main.tf.json"), "utf8"));
  const sources = Object.values(main.module).map((block) => block.source);
  record(
    "generated module sources are vendored",
    sources.length > 0 &&
      sources.every((source) => source.startsWith("./modules/aws/")),
  );
  const version = await readFile(join(root, "modules/VERSION"), "utf8").catch(
    () => "",
  );
  record(
    "modules/VERSION is stamped",
    version.trim() === tarballs[0]?.manifest.version,
  );
  if (hasTerraform) {
    if (
      step(
        "terraform init",
        run("terraform", ["init", "-backend=false", "-input=false"], {
          cwd: root,
        }),
      )
    )
      step("terraform validate", run("terraform", ["validate"], { cwd: root }));
  } else
    console.log("SKIP terraform init and validate: terraform is not installed");
}

const leaked = [];
for (const file of await files(join(project, "dist")))
  if (/\.(mjs|json)$/.test(file) || file.endsWith("Dockerfile")) {
    const text = await readFile(file, "utf8");
    for (const path of [project, ...local])
      if (text.includes(path))
        leaked.push(`${file.slice(project.length + 1)} contains a local path`);
  }
for (const file of await files(join(root))) {
  const text = await readFile(file, "utf8").catch(() => "");
  for (const path of [project, ...local])
    if (text.includes(path))
      leaked.push(`${file.slice(project.length + 1)} contains a local path`);
}
record(
  "bundles and generated files contain no local paths",
  leaked.length === 0,
  leaked.slice(0, 3).join("; "),
);

async function standalone() {
  const bundle = join(project, "dist/local/shared/index.mjs");
  const data = join(project, ".errtraq-run");
  const child = spawn(process.execPath, [bundle], {
    cwd: project,
    env: {
      ...process.env,
      ERRTRAQ_DATA_DIR: data,
      ERRTRAQ_PORT: "0",
      ERRTRAQ_HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (errors += chunk));
  const exited = new Promise((done) => child.once("exit", done));
  try {
    const deadline = Date.now() + 30000;
    while (!(output.includes("Listening:") && output.includes("API token:"))) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`server did not start: ${tail(errors)}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    const dsn = new URL(output.match(/^DSN: (.+)$/m)?.[1] ?? "");
    const eventId = "abcdef0123456789abcdef0123456789";
    const response = await fetch(
      `${dsn.origin}/api/${dsn.pathname.slice(1)}/envelope/?sentry_key=${dsn.username}`,
      {
        method: "POST",
        body: `{"event_id":"${eventId}"}\n{"type":"event"}\n{"event_id":"${eventId}","message":"packaging check"}\n`,
      },
    );
    if (response.status !== 200)
      throw new Error(`envelope answered ${response.status}`);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(data, { recursive: true, force: true });
  }
}
const failure = await standalone();
record("standalone bundle accepts an envelope", failure === "", failure);
finish();

function finish() {
  const failed = results.filter(({ ok }) => !ok);
  console.log(
    `\n${failed.length ? "FAIL" : "PASS"}: ${results.length - failed.length}/${results.length} checks passed`,
  );
  process.exit(failed.length ? 1 : 0);
}
