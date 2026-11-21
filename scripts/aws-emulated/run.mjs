import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createAwsTestNamespace } from "../../packages/testing/src/aws-emulator.ts";
import { client } from "./client.mjs";
import { probeControl } from "./probe-control.mjs";
import { probeDynamo } from "./probe-dynamodb.mjs";
import { probeS3 } from "./probe-s3.mjs";
import { probeSqs } from "./probe-sqs.mjs";
import { moduleShapes } from "./shapes.mjs";

const binary = fileURLToPath(
  new URL(
    "../../.agents-workspace/tmp/winterbaume-69fed1d7fb0eb9a2738ff3274197c7591129c4cb/target/debug/winterbaume-server",
    import.meta.url,
  ),
);
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
  for (let i = 0; i < 100; i++) {
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
  );
  try {
    const second = await createAwsTestNamespace(
      api,
      shapes.table,
      shapes.queue,
      {
        attributes: shapes.dlq,
        maxReceiveCount: 3,
      },
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
  if (failed) process.exitCode = 1;
} finally {
  processHandle.kill("SIGTERM");
  await new Promise((resolve) => {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null)
      resolve();
    else processHandle.once("exit", resolve);
  });
}
