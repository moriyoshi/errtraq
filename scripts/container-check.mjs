import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const available = spawnSync("docker", ["info"], { encoding: "utf8" });
if (available.error || available.status !== 0) {
  console.log(
    "SKIP: Docker daemon is unavailable; container check was not run.",
  );
  process.exit(0);
}
const scratch = resolve(".agents-workspace/tmp");
mkdirSync(scratch, { recursive: true });
const directory = mkdtempSync(resolve(scratch, "container-check-"));
const image = `errtraq-container-check:${randomUUID()}`;
let built = false;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args[0]} failed (${result.status})`);
}
try {
  run("pnpm", ["build"]);
  run(process.execPath, [
    "packages/cli/dist/bin.js",
    "build",
    "--stack",
    "stacks/local.ts",
    "--out",
    directory,
  ]);
  run("docker", ["build", "-t", image, directory]);
  built = true;
  const inspect = spawnSync(
    "docker",
    [
      "image",
      "inspect",
      image,
      "--format",
      "{{.Config.User}} {{json .Config.Healthcheck}}",
    ],
    { encoding: "utf8" },
  );
  if (
    inspect.status !== 0 ||
    !inspect.stdout.startsWith("node ") ||
    !inspect.stdout.includes("/health")
  )
    throw new Error("Image must have a non-root node user and health check");
  const runtime = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "node",
      image,
      "-e",
      "require('node:sqlite'); const fs=require('node:fs'); fs.accessSync('/data', fs.constants.W_OK); if (process.getuid() === 0) process.exit(1); console.log('non-root SQLite ready')",
    ],
    { encoding: "utf8" },
  );
  if (runtime.status !== 0 || !runtime.stdout.includes("non-root SQLite ready"))
    throw new Error(`Image runtime check failed: ${runtime.stderr}`);
  console.log(
    "PASS: image defaults to non-root and node:sqlite loads without a flag",
  );
  run(process.execPath, ["scripts/e2e.mjs", "--container", image]);
  console.log(
    "PASS: container image, health endpoint, random host port and full SDK e2e",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (built) spawnSync("docker", ["image", "rm", image], { stdio: "ignore" });
  rmSync(directory, { recursive: true, force: true });
}
