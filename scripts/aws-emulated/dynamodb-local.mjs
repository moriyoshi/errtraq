import { spawn, spawnSync } from "node:child_process";

// Cached image only: never pull from a registry as part of the test command.
const image =
  "amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86";
export async function testDynamoConcurrency(shapes) {
  const available = spawnSync("docker", ["image", "inspect", image], {
    stdio: "ignore",
  });
  if (available.status !== 0) {
    console.log(
      "SKIPPED DynamoDB Local concurrency contract: pinned image or Docker unavailable; winterbaume issue #61 prevents this assertion",
    );
    return;
  }
  const start = spawnSync(
    "docker",
    [
      "run",
      "--pull=never",
      "--rm",
      "-d",
      "-p",
      "127.0.0.1::8000",
      image,
      "-jar",
      "DynamoDBLocal.jar",
      "-sharedDb",
      "-inMemory",
    ],
    { encoding: "utf8" },
  );
  if (start.status !== 0)
    throw new Error(
      `DynamoDB Local container could not start: ${start.stderr.trim()}`,
    );
  const container = start.stdout.trim();
  let stopFailed = false;
  try {
    const portResult = spawnSync("docker", ["port", container, "8000/tcp"], {
      encoding: "utf8",
    });
    const port = portResult.stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (!port)
      throw new Error("DynamoDB Local did not publish a loopback port");
    const endpoint = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(endpoint, { signal: AbortSignal.timeout(500) });
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!ready) throw new Error("DynamoDB Local did not become ready");
    console.log(
      "Running unmodified 40-writer and duplicate contracts against pinned DynamoDB Local (winterbaume issue #61)",
    );
    const test = spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "packages/adapters/store-dynamodb/src/contract.emulated.test.ts",
        "packages/cli/src/deployed-bootstrap.emulated.test.ts",
        "--testNamePattern",
        "bootstraps concurrently with the real DynamoDB store and KV adapters|pages unfiltered event listings and archival scans across multiple shards|measures issue-grouped writes on DynamoDB Local|measures grouped queue contention end to end on DynamoDB Local|atomically records concurrent event groups for one issue|atomically creates or bumps, reopens regressions, and tracks the latest event|preserves an occurrence concurrent with an issue update|atomically ignores concurrent duplicate deliveries|uses compare-and-set for creation and competing writers, and lists erasures|pages erasures by state and serializes concurrent erasure transitions|atomically creates a token once and never revives a revoked token|bootstraps a DynamoDB store concurrently without prior migration|atomically creates one initial active project key",
        "--disableConsoleIntercept",
        "--testTimeout",
        "30000",
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          ERRTRAQ_DYNAMO_EMULATOR: endpoint,
          ERRTRAQ_DYNAMO_STORE_SHAPE: JSON.stringify(shapes.table),
          ERRTRAQ_DYNAMO_KV_SHAPE: JSON.stringify(shapes.kv),
          ERRTRAQ_MEASURE_ISSUE_WRITES: "1",
        },
      },
    );
    const status = await new Promise((resolve, reject) => {
      test.once("error", reject);
      test.once("exit", resolve);
    });
    if (status !== 0)
      throw new Error(`DynamoDB Local concurrency contract failed (${status})`);
  } finally {
    const stop = spawnSync("docker", ["stop", container], { stdio: "ignore" });
    stopFailed = stop.status !== 0;
  }
  if (stopFailed)
    throw new Error("Failed to stop DynamoDB Local test container");
}
