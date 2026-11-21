import { assert, check, client, unique } from "./client.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function probeSqs(endpoint) {
  const c = client(endpoint),
    name = unique(),
    results = {};
  let queue, dlq, redrive;
  try {
    dlq = (await c.sqs("CreateQueue", { QueueName: `${name}-dlq` })).QueueUrl;
    const attrs = await c.sqs("GetQueueAttributes", {
      QueueUrl: dlq,
      AttributeNames: ["QueueArn"],
    });
    queue = (
      await c.sqs("CreateQueue", {
        QueueName: name,
        Attributes: {
          VisibilityTimeout: "1",
          MessageRetentionPeriod: "345600",
          MaximumMessageSize: "1048576",
        },
      })
    ).QueueUrl;
    redrive = (
      await c.sqs("CreateQueue", {
        QueueName: `${name}-redrive`,
        Attributes: {
          VisibilityTimeout: "1",
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: attrs.Attributes.QueueArn,
            maxReceiveCount: "1",
          }),
        },
      })
    ).QueueUrl;
    await check(results, "send-receive-delete-count", async () => {
      await c.sqs("SendMessage", { QueueUrl: queue, MessageBody: "one" });
      const r = await c.sqs("ReceiveMessage", {
        QueueUrl: queue,
        AttributeNames: ["ApproximateReceiveCount"],
      });
      assert.equal(r.Messages?.[0]?.Body, "one");
      assert.equal(r.Messages[0].Attributes?.ApproximateReceiveCount, "1");
      await c.sqs("DeleteMessage", {
        QueueUrl: queue,
        ReceiptHandle: r.Messages[0].ReceiptHandle,
      });
      assert.equal(
        (await c.sqs("ReceiveMessage", { QueueUrl: queue })).Messages?.length ??
          0,
        0,
      );
    });
    await check(results, "batch-send", async () => {
      const r = await c.sqs("SendMessageBatch", {
        QueueUrl: queue,
        Entries: [
          { Id: "a", MessageBody: "a" },
          { Id: "b", MessageBody: "b" },
        ],
      });
      assert.equal(r.Successful?.length, 2);
      const messages =
        (
          await c.sqs("ReceiveMessage", {
            QueueUrl: queue,
            MaxNumberOfMessages: 10,
          })
        ).Messages ?? [];
      assert.equal(messages.length, 2);
      for (const m of messages)
        await c.sqs("DeleteMessage", {
          QueueUrl: queue,
          ReceiptHandle: m.ReceiptHandle,
        });
    });
    await check(results, "visibility", async () => {
      await c.sqs("SendMessage", {
        QueueUrl: queue,
        MessageBody: "visibility",
      });
      const m = (await c.sqs("ReceiveMessage", { QueueUrl: queue }))
        .Messages?.[0];
      assert.ok(m);
      await c.sqs("ChangeMessageVisibility", {
        QueueUrl: queue,
        ReceiptHandle: m.ReceiptHandle,
        VisibilityTimeout: 0,
      });
      const again = (
        await c.sqs("ReceiveMessage", {
          QueueUrl: queue,
          AttributeNames: ["ApproximateReceiveCount"],
        })
      ).Messages?.[0];
      assert.ok(again, "message not immediately visible");
      assert.equal(again.Attributes?.ApproximateReceiveCount, "2");
      await c.sqs("DeleteMessage", {
        QueueUrl: queue,
        ReceiptHandle: again.ReceiptHandle,
      });
    });
    await check(results, "delay", async () => {
      await c.sqs("SendMessage", {
        QueueUrl: queue,
        MessageBody: "delayed",
        DelaySeconds: 2,
      });
      assert.equal(
        (await c.sqs("ReceiveMessage", { QueueUrl: queue })).Messages?.length ??
          0,
        0,
      );
      await sleep(2200);
      const m = (await c.sqs("ReceiveMessage", { QueueUrl: queue }))
        .Messages?.[0];
      assert.equal(m?.Body, "delayed");
      await c.sqs("DeleteMessage", {
        QueueUrl: queue,
        ReceiptHandle: m.ReceiptHandle,
      });
    });
    await check(results, "redrive-dlq", async () => {
      await c.sqs("SendMessage", { QueueUrl: redrive, MessageBody: "redrive" });
      const first = (await c.sqs("ReceiveMessage", { QueueUrl: redrive }))
        .Messages?.[0];
      assert.equal(first?.Body, "redrive");
      await sleep(1300);
      await c.sqs("ReceiveMessage", { QueueUrl: redrive });
      const dead = (await c.sqs("ReceiveMessage", { QueueUrl: dlq }))
        .Messages?.[0];
      assert.equal(dead?.Body, "redrive");
      await c.sqs("DeleteMessage", {
        QueueUrl: dlq,
        ReceiptHandle: dead.ReceiptHandle,
      });
    });
  } finally {
    if (redrive)
      await c.sqs("DeleteQueue", { QueueUrl: redrive }).catch(() => {});
    if (queue) await c.sqs("DeleteQueue", { QueueUrl: queue }).catch(() => {});
    if (dlq) await c.sqs("DeleteQueue", { QueueUrl: dlq }).catch(() => {});
  }
  return results;
}
