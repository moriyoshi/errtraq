import assert from "node:assert/strict";
import { client, unique } from "./client.mjs";

/** Issues #64-#66 (fixed at v0.2.10): FIFO settings, group exclusion and receive attributes. */
export async function probeFifo(endpoint) {
  const api = client(endpoint);
  const created = await api.sqs("CreateQueue", {
    QueueName: `${unique()}.fifo`,
    Attributes: {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      DeduplicationScope: "messageGroup",
      FifoThroughputLimit: "perMessageGroupId",
    },
  });
  const url = created.QueueUrl;
  try {
    const attrs = await api.sqs("GetQueueAttributes", {
      QueueUrl: url,
      AttributeNames: ["All"],
    });
    assert.equal(attrs.Attributes?.FifoQueue, "true");
    assert.equal(attrs.Attributes?.DeduplicationScope, "messageGroup");
    assert.equal(attrs.Attributes?.FifoThroughputLimit, "perMessageGroupId");
    for (const id of ["one", "two"])
      await api.sqs("SendMessage", {
        QueueUrl: url,
        MessageBody: id,
        MessageGroupId: "issue",
        MessageDeduplicationId: id,
      });
    const first = await api.sqs("ReceiveMessage", {
      QueueUrl: url,
      MaxNumberOfMessages: 1,
      MessageSystemAttributeNames: ["All"],
    });
    const attributes = first.Messages?.[0]?.Attributes;
    assert.equal(attributes?.MessageGroupId, "issue");
    assert.equal(attributes?.MessageDeduplicationId, "one");
    assert.ok(attributes?.SequenceNumber, "SequenceNumber must be returned");
    const second = await api.sqs("ReceiveMessage", {
      QueueUrl: url,
      MaxNumberOfMessages: 1,
    });
    assert.equal(
      second.Messages?.[0],
      undefined,
      "a group with a message in flight must deliver nothing more",
    );
  } finally {
    await api.sqs("DeleteQueue", { QueueUrl: url });
  }
}
