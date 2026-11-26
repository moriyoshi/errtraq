// Opt-in: the Cloud SQL unix-socket path against a local Postgres container. Password
// authentication stands in for IAM database authentication; nothing here talks to Google.
// Docker for Mac runs in a VM, so a socket cannot be shared with the host: the Postgres server
// and the client driver run in containers that share a volume holding the socket directory.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
if (docker("info").status !== 0) {
  console.log("SKIP: Docker is unavailable; Cloud SQL socket tests not run");
  process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image =
  "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const nodeImage = process.env.ERRTRAQ_TEST_NODE_IMAGE ?? "node:22-alpine";
const name = "errtraq-g4-pg";
const volume = "errtraq-g4-sock";
const instance = "project:region:instance";
const socketDir = `/cloudsql/${instance}`;
const out = resolve(root, ".agents-workspace/tmp/g4-socket");
mkdirSync(out, { recursive: true });

// Bundle the real adapter entry with esbuild (a dependency of vite, which vitest uses).
const require = createRequire(import.meta.url);
const viteRequire = createRequire(
  require.resolve("vite", { paths: [require.resolve("vitest/package.json")] }),
);
const esbuild = await import(viteRequire.resolve("esbuild"));
await esbuild.build({
  entryPoints: [
    resolve(
      root,
      "packages/adapters/store-sql/src/postgres-cloudsql.socket-driver.ts",
    ),
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["development"],
  outfile: resolve(out, "driver.mjs"),
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "error",
});

const cleanup = () => {
  docker("rm", "-f", name);
  docker("volume", "rm", "-f", volume);
};
cleanup();
docker("volume", "create", volume);
try {
  let r = docker(
    "run",
    "--rm",
    "-v",
    `${volume}:/cloudsql`,
    "--user",
    "root",
    image,
    "sh",
    "-c",
    `mkdir -p '${socketDir}' && chown postgres '${socketDir}'`,
  );
  if (r.status !== 0)
    throw new Error(`Cannot prepare socket directory: ${r.stderr}`);
  r = docker(
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-v",
    `${volume}:/cloudsql`,
    "-e",
    "POSTGRES_PASSWORD=errtraq-admin",
    "-e",
    "POSTGRES_USER=errtraq",
    "-e",
    "POSTGRES_DB=errtraq",
    image,
    "-c",
    // The image's init-time psql clears PGHOST and looks in the default socket directory, so
    // that one stays listed first; the Cloud SQL style directory is added beside it.
    `unix_socket_directories=/var/run/postgresql,${socketDir}`,
  );
  if (r.status !== 0) throw new Error(`Cannot start Postgres: ${r.stderr}`);
  let ready = false;
  for (let attempt = 0; attempt < 90 && !ready; attempt++) {
    ready =
      docker("exec", name, "pg_isready", "-h", socketDir, "-U", "errtraq")
        .status === 0;
    if (!ready) await sleep(1000);
  }
  if (!ready) throw new Error("Postgres did not become ready");
  // The image trusts local socket connections; require passwords as Cloud SQL does.
  r = docker(
    "exec",
    "-u",
    "postgres",
    name,
    "sh",
    "-c",
    `sed -i -E 's/^(local[[:space:]]+all[[:space:]]+all[[:space:]]+)trust/\\1scram-sha-256/' "$PGDATA/pg_hba.conf" && psql -h '${socketDir}' -U errtraq -d errtraq -c 'select pg_reload_conf()'`,
  );
  if (r.status !== 0) throw new Error(`Cannot require passwords: ${r.stderr}`);
  const run = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${volume}:/cloudsql`,
      "-v",
      `${out}:/work:ro`,
      "-e",
      `DRV_INSTANCE=${instance}`,
      "-e",
      "DRV_DATABASE=errtraq",
      "-e",
      "DRV_ADMIN_USER=errtraq",
      "-e",
      "DRV_ADMIN_PASSWORD=errtraq-admin",
      "-e",
      "DRV_RUNTIME_USER=app-store@proj.iam",
      "-e",
      "DRV_RUNTIME_PASSWORD=short-lived-token",
      "-e",
      "DRV_MEMBER_USER=other-function@proj.iam",
      "-e",
      "DRV_MEMBER_PASSWORD=other-short-lived-token",
      nodeImage,
      "node",
      "/work/driver.mjs",
    ],
    { stdio: "inherit" },
  );
  if (run.status !== 0) process.exitCode = run.status ?? 1;
} finally {
  cleanup();
}
