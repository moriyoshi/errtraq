import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

// Opt-in harness: runs the blob-gcs contract suite against a pinned fake-gcs-server container.
// Image digest recorded 2026-11-26 for 1.56.1 (multi-arch index):
//   sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef
const image =
  "fsouza/fake-gcs-server:1.56.1@sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef";
const name = "errtraq-g1-gcs";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...options });
}
async function ready(url) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(`${url}/storage/v1/b`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("fake-gcs-server did not become ready");
}

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
docker(["rm", "-f", name]);
const started = docker([
  "run",
  "-d",
  "--name",
  name,
  "-p",
  `127.0.0.1:${port}:4443`,
  image,
  "-scheme",
  "http",
  "-port",
  "4443",
  "-external-url",
  url,
  "-public-host",
  `127.0.0.1:${port}`,
]);
if (started.status !== 0) {
  console.error(started.stderr);
  process.exit(1);
}
let status = 1;
try {
  await ready(url);
  status = await new Promise((resolve) =>
    spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "packages/adapters/blob-gcs/src/contract.emulated.test.ts",
      ],
      {
        stdio: "inherit",
        env: { ...process.env, ERRTRAQ_GCS_EMULATOR: url },
      },
    ).on("close", (code) => resolve(code ?? 1)),
  );
} finally {
  docker(["rm", "-f", name]);
}
process.exit(status);
