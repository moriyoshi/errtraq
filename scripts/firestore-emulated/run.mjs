import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";

// Opt-in harness: runs the Firestore suite(s) against a pinned Cloud SDK emulator container.
// Image digest recorded 2026-11-26 (google-cloud-cli):
const image =
  "gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:17b4e7f940db19984c051a321c32f57bf679cb7148835fd16ddc7ce2908a70d8";
const name = "errtraq-g3-firestore";
const suites = [
  "packages/adapters/store-firestore/src/contract.emulated.test.ts",
  "packages/adapters/kv-firestore/src/contract.emulated.test.ts",
];

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
// The emulators speak HTTP on the same port; any HTTP response means the listener is up.
async function ready(port) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2000),
      });
      return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Firestore emulator did not become ready");
}

const port = await freePort();
docker(["rm", "-f", name]);
const started = docker([
  "run",
  "-d",
  "--rm",
  "--name",
  name,
  "-p",
  `127.0.0.1:${port}:8080`,
  image,
  "gcloud",
  "emulators",
  "firestore",
  "start",
  "--host-port=0.0.0.0:8080",
]);
if (started.status !== 0) {
  console.error(started.stderr);
  process.exit(1);
}
let status = 1;
try {
  await ready(port);
  status = await new Promise((resolve) =>
    // The contended-transaction cases retry against the emulator's pessimistic locking and
    // routinely exceed vitest's 5 s default.
    spawn(
      "pnpm",
      ["exec", "vitest", "run", "--testTimeout=120000", ...suites],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          ERRTRAQ_FIRESTORE_EMULATOR: `127.0.0.1:${port}`,
        },
      },
    ).on("close", (code) => resolve(code ?? 1)),
  );
} finally {
  docker(["rm", "-f", name]);
}
process.exit(status);
