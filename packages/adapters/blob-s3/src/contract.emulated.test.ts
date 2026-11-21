import { randomUUID } from "node:crypto";
import { blobStoreContract } from "@errtraq/testing";
import { AwsV4Signer } from "aws4fetch";
import { afterEach, describe, expect, it } from "vitest";
import { S3BlobStore } from "./runtime.js";

const endpoint = process.env.ERRTRAQ_S3_EMULATOR;
const local = endpoint ? new URL(endpoint) : undefined;
if (local && (local.protocol !== "http:" || local.hostname !== "127.0.0.1"))
  throw new Error("S3 contract endpoint must be loopback");
const active: { bucket: string; store: S3BlobStore }[] = [];
const credentials = { accessKeyId: "emulator", secretAccessKey: "emulator" };
async function bucketRequest(bucket: string, method: string) {
  const signed = await new AwsV4Signer({
    url: `${endpoint}/${bucket}`,
    method,
    ...credentials,
    service: "s3",
    region: "us-east-1",
  }).sign();
  const response = await fetch(signed.url, { method, headers: signed.headers });
  if (!response.ok)
    throw new Error(`Bucket ${method} failed (${response.status})`);
}

async function makeStore() {
  const bucket = `errtraq-${randomUUID().replaceAll("-", "")}`;
  await bucketRequest(bucket, "PUT");
  const store = new S3BlobStore({
    bucket,
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: () => credentials,
  });
  active.push({ bucket, store });
  return store;
}

describe.skipIf(!endpoint)("S3 emulator", () => {
  afterEach(async () => {
    for (const { bucket, store } of active.splice(0)) {
      let page = await store.list("");
      while (page.items.length) {
        for (const key of page.items) await store.delete(key);
        page = await store.list("");
      }
      await bucketRequest(bucket, "DELETE");
    }
  });
  blobStoreContract(makeStore);
  it("uploads unknown-length multipart and empty streams", async () => {
    const store = await makeStore();
    const chunk = new Uint8Array(5 * 1024 * 1024).fill(7);
    await store.put(
      "big",
      new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
    );
    expect((await store.head("big"))?.size).toBe(chunk.length + 3);
    const tail = await store.get("big", {
      range: { offset: chunk.length, length: 3 },
    });
    expect(new Uint8Array(await new Response(tail).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await store.put(
      "empty",
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    );
    expect((await store.head("empty"))?.size).toBe(0);
  }, 30000);
});
