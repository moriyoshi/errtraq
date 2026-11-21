import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
if (docker("info").status !== 0) {
  console.log(
    "SKIP: Docker is unavailable; Postgres integration tests not run",
  );
  process.exit(0);
}
const image =
  "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const created = docker(
  "run",
  "-d",
  "--rm",
  "-e",
  "POSTGRES_PASSWORD=errtraq-test",
  "-e",
  "POSTGRES_USER=errtraq",
  "-e",
  "POSTGRES_DB=errtraq",
  "-p",
  "127.0.0.1::5432",
  image,
);
if (created.status !== 0)
  throw new Error(`Cannot start Postgres: ${created.stderr}`);
const id = created.stdout.trim();
try {
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    if (docker("exec", id, "pg_isready", "-U", "errtraq").status === 0) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready) throw new Error("Postgres did not become ready");
  const port = docker("port", id, "5432/tcp")
    .stdout.trim()
    .match(/:(\d+)$/)?.[1];
  if (!port) throw new Error("Postgres loopback port missing");
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "packages/adapters/store-sql/src/postgres.integration.test.ts",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ERRTRAQ_TEST_POSTGRES: `postgresql://errtraq:errtraq-test@127.0.0.1:${port}/errtraq`,
      },
    },
  );
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  docker("stop", "-t", "2", id);
}
