import { spawn, spawnSync } from "node:child_process";
import { startEmulators, unavailable } from "./containers.mjs";
import { runE2e } from "./e2e.mjs";

// Opt-in: the Firestore, Pub/Sub and GCS emulators, the GCP contract suites, then the Cloud Run
// handler end to end. What the emulators cannot check is listed in .agents-docs/GCP_EMULATOR_GAPS.md.
const reason = unavailable();
if (reason) {
  console.log(`SKIP GCP emulator tests: ${reason}.`);
  process.exit(0);
}
// The end to end runs the built CLI and handler bundle.
const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
  stdio: "inherit",
});
if (built.status !== 0) process.exit(built.status ?? 1);

const emulators = await startEmulators();
let status = 1;
try {
  console.log(
    `Emulators: ${emulators.env.FIRESTORE_EMULATOR_HOST} (Firestore), ${emulators.env.PUBSUB_EMULATOR_HOST} (Pub/Sub), ${emulators.env.STORAGE_EMULATOR_HOST} (GCS)`,
  );
  status = await new Promise((resolve) =>
    spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        // Contended Firestore transactions retry against pessimistic locking and exceed 5 s.
        "--testTimeout=120000",
        "packages/adapters/store-firestore/src/contract.emulated.test.ts",
        "packages/adapters/kv-firestore/src/contract.emulated.test.ts",
        "packages/adapters/queue-pubsub/src/contract.emulated.test.ts",
        "packages/adapters/blob-gcs/src/contract.emulated.test.ts",
      ],
      { stdio: "inherit", env: { ...process.env, ...emulators.env } },
    ).on("close", (code) => resolve(code ?? 1)),
  );
  if (status === 0) {
    for (const [name, value] of Object.entries(emulators.env))
      process.env[name] = value;
    await runE2e(emulators);
  }
} catch (error) {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  status = 1;
} finally {
  emulators.stop();
}
process.exit(status);
