import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

/**
 * Container helpers of `pnpm test:gcp-emulated`. Every container is named `errtraq-g7-*` and
 * removed on exit; nothing else in Docker is touched.
 */
// Image digests recorded 2026-11-26 (the same pins the per-service harnesses use).
export const CLOUD_SDK_IMAGE =
  "gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:17b4e7f940db19984c051a321c32f57bf679cb7148835fd16ddc7ce2908a70d8";
export const FAKE_GCS_IMAGE =
  "fsouza/fake-gcs-server:1.56.1@sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef";
export const PROJECT = "errtraq-test";

export function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", ...options });
}
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
/** Why the suite cannot run here, or undefined when Docker and both images are available. */
export function unavailable() {
  const info = docker(["info"]);
  if (info.error || info.status !== 0)
    return "Docker is unavailable (start it, or ignore this on machines without Docker)";
  for (const image of [CLOUD_SDK_IMAGE, FAKE_GCS_IMAGE]) {
    if (docker(["image", "inspect", image]).status === 0) continue;
    console.log(`Pulling ${image.split("@")[0]} ...`);
    const pulled = docker(["pull", image], { stdio: "inherit" });
    if (pulled.status !== 0)
      return `the image ${image.split("@")[0]} is missing and cannot be pulled`;
  }
  return undefined;
}
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if (await check()) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} did not become ready`);
}
const http = async (url) => {
  await fetch(url, { signal: AbortSignal.timeout(2000) });
  return true;
};

/** Start the three emulators on free loopback ports; `stop()` removes the containers. */
export async function startEmulators() {
  const names = ["errtraq-g7-firestore", "errtraq-g7-pubsub", "errtraq-g7-gcs"];
  const stop = () => {
    for (const name of names) docker(["rm", "-f", name]);
  };
  stop();
  const ports = {
    firestore: await freePort(),
    pubsub: await freePort(),
    gcs: await freePort(),
  };
  const start = (args) => {
    const started = docker(["run", "-d", "--rm", ...args]);
    if (started.status !== 0) {
      stop();
      throw new Error(`Cannot start an emulator: ${started.stderr}`);
    }
  };
  const gcsOrigin = `http://127.0.0.1:${ports.gcs}`;
  try {
    start([
      "--name",
      names[0],
      "-p",
      `127.0.0.1:${ports.firestore}:8080`,
      CLOUD_SDK_IMAGE,
      "gcloud",
      "emulators",
      "firestore",
      "start",
      "--host-port=0.0.0.0:8080",
    ]);
    start([
      "--name",
      names[1],
      "-p",
      `127.0.0.1:${ports.pubsub}:8080`,
      CLOUD_SDK_IMAGE,
      "gcloud",
      "beta",
      "emulators",
      "pubsub",
      "start",
      "--host-port=0.0.0.0:8080",
      `--project=${PROJECT}`,
    ]);
    start([
      "--name",
      names[2],
      "-p",
      `127.0.0.1:${ports.gcs}:4443`,
      FAKE_GCS_IMAGE,
      "-scheme",
      "http",
      "-port",
      "4443",
      "-external-url",
      gcsOrigin,
      "-public-host",
      `127.0.0.1:${ports.gcs}`,
    ]);
    await Promise.all([
      waitFor(
        () => http(`http://127.0.0.1:${ports.firestore}/`),
        "Firestore emulator",
      ),
      waitFor(
        () => http(`http://127.0.0.1:${ports.pubsub}/`),
        "Pub/Sub emulator",
      ),
      waitFor(
        async () => (await fetch(`${gcsOrigin}/storage/v1/b`)).ok,
        "fake-gcs-server",
      ),
    ]);
  } catch (error) {
    stop();
    throw error;
  }
  return {
    ports,
    /** The standard variables client libraries (and the adapters) read. */
    env: {
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.firestore}`,
      PUBSUB_EMULATOR_HOST: `127.0.0.1:${ports.pubsub}`,
      STORAGE_EMULATOR_HOST: gcsOrigin,
      // The names the per-service contract suites take.
      ERRTRAQ_FIRESTORE_EMULATOR: `127.0.0.1:${ports.firestore}`,
      ERRTRAQ_PUBSUB_EMULATOR: `127.0.0.1:${ports.pubsub}`,
      ERRTRAQ_GCS_EMULATOR: gcsOrigin,
    },
    gcsOrigin,
    stop,
  };
}
