import { randomUUID } from "node:crypto";
import { signAwsRequest } from "@errtraq/aws-signing";
import type { BatchHandler, Queue } from "@errtraq/core";
import { queueContract } from "@errtraq/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SqsQueue } from "./runtime.js";

const endpoint = process.env.ERRTRAQ_SQS_EMULATOR;
if (endpoint && new URL(endpoint).origin !== endpoint)
  throw new Error("Invalid emulator origin");
if (endpoint && new URL(endpoint).hostname !== "127.0.0.1")
  throw new Error("SQS emulator must be loopback");
const environment = {
  AWS_ACCESS_KEY_ID: "emulator",
  AWS_SECRET_ACCESS_KEY: "emulator",
};
async function api(action: string, value: Record<string, unknown>) {
  if (!endpoint) throw new Error("Missing emulator endpoint");
  const body = JSON.stringify(value);
  const signed = await signAwsRequest({
    url: `${endpoint}/`,
    method: "POST",
    body,
    service: "sqs",
    region: "us-east-1",
    accessKeyId: environment.AWS_ACCESS_KEY_ID,
    secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": `AmazonSQS.${action}`,
    },
  });
  const response = await fetch(signed.url, {
    method: "POST",
    body,
    headers: signed.headers,
  });
  if (!response.ok)
    throw new Error(`SQS emulator ${action} failed: ${await response.text()}`);
  return await response.json();
}
type Physical = { url: string; arn: string };
const live: Physical[] = [];
const queues = new WeakMap<Queue, Physical[]>();
async function makeQueue(mode: "shared" | "per-topic") {
  const names = mode === "shared" ? ["shared"] : ["ingest", "archive"];
  const physical = new Map<string, Physical>();
  for (const key of names) {
    const name = `errtraq-${randomUUID().replaceAll("-", "")}`;
    const { QueueUrl } = await api("CreateQueue", {
      QueueName: name,
      Attributes: { VisibilityTimeout: "1", MaximumMessageSize: "1048576" },
    });
    const { Attributes } = await api("GetQueueAttributes", {
      QueueUrl,
      AttributeNames: ["QueueArn"],
    });
    const queue = {
      url: QueueUrl as string,
      arn: Attributes.QueueArn as string,
    };
    live.push(queue);
    physical.set(key, queue);
  }
  const key = (topic: string) =>
    mode === "shared"
      ? "shared"
      : topic === "archive.project"
        ? "archive"
        : "ingest";
  const topics = Object.fromEntries(
    ["ingest", "archive.project", "contract"].map((topic) => [
      topic,
      { physical: key(topic), producerBinding: key(topic) },
    ]),
  );
  const bindings = Object.fromEntries(
    [...physical].map(([name, queue]) => [name, queue.url]),
  );
  const consumers = [...physical].map(([name, queue]) => ({
    physical: name,
    eventSource: queue.arn,
    topics: Object.keys(topics).filter((topic) => key(topic) === name),
  }));
  const queue = new SqsQueue({
    region: "us-east-1",
    environment,
    bindings,
    topics,
    consumers,
    endpoint,
  });
  queues.set(queue, [...physical.values()]);
  return queue;
}
async function deliver(queue: Queue, handler: BatchHandler) {
  if (!queue.push) throw new Error("Missing push source");
  // Let the one-second source visibility timeout expire before polling for retries.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  for (const physical of queues.get(queue) ?? []) {
    const received = await api("ReceiveMessage", {
      QueueUrl: physical.url,
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 1,
      AttributeNames: ["ApproximateReceiveCount"],
    });
    const messages = (received.Messages ?? []) as {
      MessageId: string;
      ReceiptHandle: string;
      Body: string;
      Attributes: Record<string, string>;
    }[];
    if (!messages.length) continue;
    const event = {
      Records: messages.map((message) => ({
        messageId: message.MessageId,
        receiptHandle: message.ReceiptHandle,
        body: message.Body,
        attributes: message.Attributes,
        eventSourceARN: physical.arn,
        eventSource: "aws:sqs",
        awsRegion: "us-east-1",
        messageAttributes: {},
        md5OfBody: "fixture",
      })),
    };
    const result = (await queue.push.handle(event, handler)) as {
      batchItemFailures: { itemIdentifier: string }[];
    };
    const failures = new Set(
      result.batchItemFailures.map((failure) => failure.itemIdentifier),
    );
    for (const message of messages)
      if (!failures.has(message.MessageId))
        await api("DeleteMessage", {
          QueueUrl: physical.url,
          ReceiptHandle: message.ReceiptHandle,
        });
  }
}

describe.skipIf(!endpoint)("SQS emulator", () => {
  afterEach(async () => {
    for (const queue of live.splice(0))
      await api("DeleteQueue", { QueueUrl: queue.url });
  });
  for (const mode of ["shared", "per-topic"] as const)
    describe(mode, () => {
      queueContract(() => makeQueue(mode), { deliverPush: deliver });
      it("honors delayed retry through visibility and partial batch failures", async () => {
        const queue = await makeQueue(mode);
        await queue.producer.send("ingest", [
          { key: "a", body: 1 },
          { key: "b", body: 2 },
        ]);
        const seen: string[] = [];
        await deliver(queue, async (batch) =>
          batch.map((d) => {
            seen.push(d.message.key);
            return d.message.key === "a"
              ? { deliveryId: d.id, action: "retry" as const, delaySec: 2 }
              : { deliveryId: d.id, action: "ack" as const };
          }),
        );
        await deliver(queue, async (batch) => {
          seen.push(...batch.map((d) => d.message.key));
          return batch.map((d) => ({
            deliveryId: d.id,
            action: "ack" as const,
          }));
        });
        expect(seen.sort()).toEqual(["a", "b"]);
        await deliver(queue, async (batch) => {
          seen.push(...batch.map((d) => d.message.key));
          return batch.map((d) => ({
            deliveryId: d.id,
            action: "ack" as const,
          }));
        });
        expect(seen.sort()).toEqual(["a", "a", "b"]);
      }, 15000);
    });
});
