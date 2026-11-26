import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { createAwsTestNamespace } from "../../packages/testing/src/aws-emulator.ts";
import { client } from "./client.mjs";
import { testDynamoConcurrency } from "./dynamodb-local.mjs";
import { defaultBinary } from "./emulator-binary.mjs";
import { assertConditionalUpdateAtomic } from "./gap-checks.mjs";
import { probeControl } from "./probe-control.mjs";
import { probeDynamo } from "./probe-dynamodb.mjs";
import { probeFifo } from "./probe-fifo.mjs";
import { probeS3 } from "./probe-s3.mjs";
import { probeSqs } from "./probe-sqs.mjs";
import { moduleShapes } from "./shapes.mjs";

const binary = defaultBinary();
try {
  await access(binary);
} catch {
  console.log("SKIP AWS emulator tests: run pnpm aws-emulator:install first.");
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
let stderr = "";
processHandle.stderr.on("data", (data) => {
  stderr = (stderr + data).slice(-4000);
});
let exited;
processHandle.once("exit", (code) => {
  exited = code ?? "signal";
});
const endpoint = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let i = 0; i < 600; i++) {
    if (exited !== undefined)
      throw new Error(`Emulator exited (${exited}): ${stderr}`);
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
  if (!ready) throw new Error(`Emulator did not start: ${stderr}`);
  const results = {
    s3: await probeS3(endpoint),
    dynamodb: await probeDynamo(endpoint),
    sqs: await probeSqs(endpoint),
  };
  let failed = false;
  for (const [service, checks] of Object.entries(results))
    for (const [name, result] of Object.entries(checks)) {
      console.log(
        `${result.supported ? "PASS" : "FAIL"} ${service} ${name}${result.detail ? `: ${result.detail}` : ""}`,
      );
      if (!result.supported) failed = true;
    }
  await probeFifo(endpoint);
  console.log("PASS sqs fifo settings, group exclusion and receive attributes");
  const control = await probeControl(endpoint);
  for (const [name, result] of Object.entries(control)) {
    console.log(
      `CONTROL ${result.supported ? "PASS" : "UNCONFIRMED"} ${name}${result.detail ? `: ${result.detail}` : ""}`,
    );
  }
  const shapes = await moduleShapes();
  const api = client(endpoint);
  const first = await createAwsTestNamespace(
    api,
    shapes.table,
    shapes.queue,
    {
      attributes: shapes.dlq,
      maxReceiveCount: 3,
    },
    shapes.kv,
    shapes.ttl,
    shapes.kvTtl,
    shapes.metadata,
  );
  try {
    const metadata = await api.dynamo("GetItem", {
      TableName: first.table,
      Key: { PK: shapes.metadata.PK, SK: shapes.metadata.SK },
      ConsistentRead: true,
    });
    if (
      metadata.Item?.projectTimeShards?.N !==
      shapes.metadata.projectTimeShards.N
    )
      throw new Error("Module-derived shard metadata missing");
    const second = await createAwsTestNamespace(
      api,
      shapes.table,
      shapes.queue,
      {
        attributes: shapes.dlq,
        maxReceiveCount: 3,
      },
      undefined,
      shapes.ttl,
      undefined,
      shapes.metadata,
    );
    try {
      if (
        first.table === second.table ||
        first.queueUrl === second.queueUrl ||
        first.bucket === second.bucket
      )
        throw new Error("Namespaces collided");
      await api.request("s3", `/${first.bucket}/nested/example`, {
        method: "PUT",
        body: "test",
      });
      console.log(
        "PASS isolated namespaces and module-derived table/queue shapes",
      );
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
  for (const operation of [
    () => api.dynamo("DescribeTable", { TableName: first.table }),
    () => api.dynamo("DescribeTable", { TableName: first.kvTable }),
    () =>
      api.sqs("GetQueueAttributes", {
        QueueUrl: first.queueUrl,
        AttributeNames: ["QueueArn"],
      }),
    () => api.request("s3", `/${first.bucket}`),
  ]) {
    let removed = false;
    try {
      await operation();
    } catch {
      removed = true;
    }
    if (!removed) throw new Error("Namespace cleanup left a resource behind");
  }
  console.log("PASS namespace cleanup");
  await assertConditionalUpdateAtomic(api);
  console.log("PASS dynamodb conditional-update atomicity");
  console.log(
    "Running the full DynamoDB store repository contract (concurrent and CAS cases included; issue #61 fixed at v0.2.10)",
  );
  const storeContract = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "packages/adapters/store-dynamodb/src/contract.emulated.test.ts",
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
      },
    },
  );
  const storeStatus = await new Promise((resolve, reject) => {
    storeContract.once("error", reject);
    storeContract.once("exit", resolve);
  });
  if (storeStatus !== 0)
    throw new Error(
      `DynamoDB store repository contract failed (${storeStatus})`,
    );
  await testDynamoConcurrency(shapes);
  console.log("Running DynamoDB KV contract against the unmodified emulator");
  const kvContract = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "packages/adapters/kv-dynamodb/src/contract.emulated.test.ts",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ERRTRAQ_DYNAMO_EMULATOR: endpoint,
        ERRTRAQ_DYNAMO_KV_SHAPE: JSON.stringify(shapes.kv),
        ERRTRAQ_DYNAMO_TTL_ATTRIBUTE: shapes.kvTtl,
      },
    },
  );
  const kvStatus = await new Promise((resolve, reject) => {
    kvContract.once("error", reject);
    kvContract.once("exit", resolve);
  });
  if (kvStatus !== 0)
    throw new Error(`DynamoDB KV contract failed (${kvStatus})`);
  console.log(
    "Running SQS shared and per-topic contracts against the unmodified emulator",
  );
  const sqsContract = spawn(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "packages/adapters/queue-sqs/src/contract.emulated.test.ts",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, ERRTRAQ_SQS_EMULATOR: endpoint },
    },
  );
  const sqsStatus = await new Promise((resolve, reject) => {
    sqsContract.once("error", reject);
    sqsContract.once("exit", resolve);
  });
  if (sqsStatus !== 0)
    throw new Error(`SQS contract runner failed (${sqsStatus})`);
  console.log("Running S3 BlobStore contract against the unmodified emulator");
  const s3Contract = spawn(
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
  const s3Status = await new Promise((resolve, reject) => {
    s3Contract.once("error", reject);
    s3Contract.once("exit", resolve);
  });
  if (s3Status !== 0)
    throw new Error(`S3 contract runner failed (${s3Status})`);
  if (failed) process.exitCode = 1;
} finally {
  processHandle.kill("SIGTERM");
  await new Promise((resolve) => {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null)
      resolve();
    else processHandle.once("exit", resolve);
  });
}
