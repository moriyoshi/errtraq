import { S3BlobStore } from "../packages/adapters/blob-s3/src/runtime.js";
import { DynamoKV } from "../packages/adapters/kv-dynamodb/src/runtime.js";
import { SqsQueue } from "../packages/adapters/queue-sqs/src/runtime.js";
export default {
  async fetch(_request: Request, env: { ENDPOINT: string }) {
    const environment = {
      AWS_ACCESS_KEY_ID: "fixture",
      AWS_SECRET_ACCESS_KEY: "fixture",
    };
    const blob = new S3BlobStore({
      allowedPrefixes: [""],
      bucket: "bucket",
      region: "us-east-1",
      endpoint: env.ENDPOINT,
      forcePathStyle: true,
      credentials: () => ({
        accessKeyId: "fixture",
        secretAccessKey: "fixture",
      }),
    });
    const queue = new SqsQueue({
      region: "us-east-1",
      environment,
      endpoint: env.ENDPOINT,
      bindings: { URL: `${env.ENDPOINT}/queue` },
      topics: { ingest: { physical: "shared", producerBinding: "URL" } },
      consumers: [
        {
          physical: "shared",
          topics: ["ingest"],
          eventSource: "arn:aws:sqs:us-east-1:123456789012:test",
        },
      ],
    });
    const kv = new DynamoKV({
      table: "table",
      region: "us-east-1",
      environment,
      endpoint: env.ENDPOINT,
    });
    await blob.put("object", new Uint8Array([1]));
    await queue.producer.send("ingest", [{ key: "key", body: 1 }]);
    await kv.put("key", "value");
    const result = await queue.push.handle(
      {
        Records: [
          {
            messageId: "id",
            receiptHandle: "receipt",
            body: JSON.stringify({
              topic: "ingest",
              message: { key: "key", body: 1 },
            }),
            attributes: { ApproximateReceiveCount: "1" },
            eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:test",
          },
        ],
      },
      async (batch) =>
        batch.map((item) => ({
          deliveryId: item.id,
          action: "retry" as const,
          delaySec: 2,
        })),
    );
    if (result.batchItemFailures[0]?.itemIdentifier !== "id")
      throw new Error("Unexpected queue failure result");
    return new Response("ok");
  },
};
