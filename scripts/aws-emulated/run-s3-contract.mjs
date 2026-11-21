import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const binary =
  process.env.ERRTRAQ_S3_EMULATOR_BINARY ??
  fileURLToPath(
    new URL(
      "../../.agents-workspace/tmp/winterbaume-79c452d2bb2844abf771cfa4a497275c24b46489-s3-utf8/target/debug/winterbaume-server",
      import.meta.url,
    ),
  );
try {
  await access(binary);
} catch {
  console.log(
    "SKIP S3 contract: run pnpm aws-emulator:install-s3-patched first.",
  );
  process.exit(0);
}
const socket = createServer();
await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", resolve);
});
const port = socket.address().port;
await new Promise((resolve, reject) =>
  socket.close((error) => (error ? reject(error) : resolve())),
);
const processHandle = spawn(
  binary,
  ["--host", "127.0.0.1", "--port", String(port)],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let errorLog = "",
  exited = false;
processHandle.stderr.on("data", (data) => {
  errorLog = (errorLog + data).slice(-4000);
});
processHandle.once("exit", () => {
  exited = true;
});
const endpoint = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 600; i++) {
    if (exited) throw new Error(`Patched emulator exited: ${errorLog}`);
    try {
      await fetch(endpoint, {
        signal: AbortSignal.timeout(500),
        redirect: "error",
      });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) throw new Error(`Patched emulator did not start: ${errorLog}`);
  console.log(
    "Running S3 contract against the checksum-verified UTF-8 patched emulator",
  );
  const test = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "packages/adapters/blob-s3/src/contract.emulated.test.ts",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, ERRTRAQ_S3_EMULATOR: endpoint },
    },
  );
  const status = await new Promise((resolve, reject) => {
    test.once("error", reject);
    test.once("exit", resolve);
  });
  if (status !== 0) throw new Error(`S3 contract failed (${status})`);
} finally {
  processHandle.kill("SIGTERM");
  await new Promise((resolve) => {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null)
      resolve();
    else processHandle.once("exit", resolve);
  });
}
