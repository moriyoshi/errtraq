import assert from "node:assert/strict";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { probeFifo } from "./probe-fifo.mjs";
import { providerOverride } from "./terraform-config.mjs";

/** Apply the unmodified module and read the queues back. */
export async function applyFifo({
  c,
  temp,
  modules,
  version,
  cache,
  endpoint,
  tf,
}) {
  await probeFifo(endpoint);
  const dir = resolve(temp, "fifo-standalone"),
    moduleDir = resolve(dir, "module");
  mkdirSync(dir, { recursive: true });
  cpSync(resolve(modules, "aws/sqs"), moduleDir, { recursive: true });
  writeFileSync(
    resolve(dir, "main.tf.json"),
    JSON.stringify(
      {
        terraform: {
          required_providers: {
            aws: { source: "hashicorp/aws", version: `= ${version}` },
          },
        },
        provider: { aws: [{ region: "us-east-1" }] },
        module: {
          queue: {
            source: "./module",
            name: "m3-fifo",
            tags: {},
            physical_queues: {
              record: {
                fifo: true,
                visibility_timeout_sec: 180,
                dlq_enabled: true,
                max_receive_count: 5,
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(dir, "emulator_override.tf.json"),
    JSON.stringify(providerOverride(endpoint, version), null, 2),
  );
  tf(dir, "init", "-backend=false", "-input=false", `-plugin-dir=${cache}`);
  tf(dir, "apply", "-auto-approve", "-input=false");
  const queue = await c.sqs("GetQueueUrl", {
    QueueName: "m3-fifo-record.fifo",
  });
  const dlq = await c.sqs("GetQueueUrl", {
    QueueName: "m3-fifo-record-dlq.fifo",
  });
  const attrs = await c.sqs("GetQueueAttributes", {
    QueueUrl: queue.QueueUrl,
    AttributeNames: ["All"],
  });
  const dead = await c.sqs("GetQueueAttributes", {
    QueueUrl: dlq.QueueUrl,
    AttributeNames: ["All"],
  });
  assert.equal(attrs.Attributes.FifoQueue, "true");
  assert.equal(attrs.Attributes.DeduplicationScope, "messageGroup");
  assert.equal(attrs.Attributes.FifoThroughputLimit, "perMessageGroupId");
  assert.equal(dead.Attributes.FifoQueue, "true");
  assert.equal(
    JSON.parse(attrs.Attributes.RedrivePolicy).deadLetterTargetArn,
    dead.Attributes.QueueArn,
  );
  console.log("PASS FIFO queue and FIFO DLQ apply and API readback");
  tf(dir, "destroy", "-auto-approve", "-input=false");
  console.log("PASS FIFO queue and FIFO DLQ destroy");
}
