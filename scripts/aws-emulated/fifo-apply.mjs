import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { skipped } from "./gaps.mjs";
import { probeFifo } from "./probe-fifo.mjs";
import { providerOverride } from "./terraform-config.mjs";

/** Apply the real module with only unsupported readback settings removed in its scratch copy. */
export async function applyFifo({
  c,
  gaps,
  temp,
  modules,
  version,
  cache,
  endpoint,
  tf,
}) {
  await probeFifo(endpoint);
  skipped(gaps, "sqs-fifo");
  const dir = resolve(temp, "fifo-standalone"),
    moduleDir = resolve(dir, "module");
  mkdirSync(dir, { recursive: true });
  cpSync(resolve(modules, "aws/sqs"), moduleDir, { recursive: true });
  const file = resolve(moduleDir, "main.tf");
  let source = readFileSync(file, "utf8");
  for (const [from, to] of [
    [
      'deduplication_scope         = each.value.fifo ? "messageGroup" : null',
      "deduplication_scope         = null",
    ],
    [
      'fifo_throughput_limit       = each.value.fifo ? "perMessageGroupId" : null',
      "fifo_throughput_limit       = null",
    ],
  ]) {
    if (source.split(from).length !== 2)
      throw new Error("FIFO emulator override no longer matches");
    source = source.replace(from, to);
  }
  writeFileSync(file, source);
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
  assert.equal(dead.Attributes.FifoQueue, "true");
  assert.equal(
    JSON.parse(attrs.Attributes.RedrivePolicy).deadLetterTargetArn,
    dead.Attributes.QueueArn,
  );
  console.log(
    "PASS FIFO queue and FIFO DLQ apply and API readback (named emulator exceptions above)",
  );
  tf(dir, "destroy", "-auto-approve", "-input=false");
  console.log("PASS FIFO queue and FIFO DLQ destroy");
}
