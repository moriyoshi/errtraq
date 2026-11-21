import { S3BlobStore } from "../packages/adapters/blob-s3/src/runtime.js";
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
      consumers: [],
    });
    await blob.put("object", new Uint8Array([1]));
    await queue.producer.send("ingest", [{ key: "key", body: 1 }]);
    return new Response("ok");
  },
};
