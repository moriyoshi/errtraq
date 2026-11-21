import { client, unique } from "./client.mjs";

/** The pin accepts FIFO but loses settings and group isolation; fail when the gap changes. */
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
    if (
      attrs.Attributes?.FifoQueue !== "true" ||
      attrs.Attributes?.DeduplicationScope !== "queue" ||
      attrs.Attributes?.FifoThroughputLimit !== "perQueue"
    )
      throw new Error("FIFO settings gap changed; update the gap inventory");
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
      AttributeNames: ["All"],
    });
    const second = await api.sqs("ReceiveMessage", {
      QueueUrl: url,
      MaxNumberOfMessages: 1,
      AttributeNames: ["All"],
    });
    if (
      !first.Messages?.[0] ||
      !second.Messages?.[0] ||
      first.Messages[0].Attributes?.MessageGroupId !== undefined
    )
      throw new Error("FIFO delivery gap changed; update the gap inventory");
  } finally {
    await api.sqs("DeleteQueue", { QueueUrl: url });
  }
}
