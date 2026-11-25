import { randomUUID } from "node:crypto";
import { staticTokenSource } from "@moriyoshi/errtraq-gcp-auth";
import { blobStoreContract } from "@moriyoshi/errtraq-testing";
import { afterEach, describe, expect, it } from "vitest";
import { GcsBlobStore } from "./runtime.js";

// Opt-in: ERRTRAQ_GCS_EMULATOR=http://127.0.0.1:<port> points at a GCS JSON API emulator
// (fake-gcs-server or storage-testbench). The default test run skips this file.
const endpoint = process.env.ERRTRAQ_GCS_EMULATOR;
const local = endpoint ? new URL(endpoint) : undefined;
if (local && (local.protocol !== "http:" || local.hostname !== "127.0.0.1"))
  throw new Error("GCS contract endpoint must be loopback");
const active: { bucket: string; store: GcsBlobStore }[] = [];

async function createBucket(bucket: string) {
  const response = await fetch(`${endpoint}/storage/v1/b?project=emulator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: bucket }),
  });
  if (!response.ok)
    throw new Error(`Bucket create failed (${response.status})`);
}
async function makeStore(chunkSize?: number) {
  const bucket = `errtraq-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await createBucket(bucket);
  const store = new GcsBlobStore({
    allowedPrefixes: [""],
    bucket,
    endpoint,
    tokens: staticTokenSource(""),
    chunkSize,
  });
  active.push({ bucket, store });
  return store;
}

describe.skipIf(!endpoint)("GCS emulator", () => {
  afterEach(async () => {
    for (const { bucket, store } of active.splice(0)) {
      let page = await store.list("");
      while (page.items.length) {
        for (const key of page.items) await store.delete(key);
        page = await store.list("");
      }
      await fetch(`${endpoint}/storage/v1/b/${bucket}`, { method: "DELETE" });
    }
  });
  blobStoreContract(() => makeStore());
  it("uploads multi-chunk resumable streams and an empty stream", async () => {
    const store = await makeStore(256 * 1024);
    const chunk = new Uint8Array(256 * 1024 * 2).map((_, i) => i % 253);
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
    const whole = await store.get("big");
    expect((await new Response(whole).arrayBuffer()).byteLength).toBe(
      chunk.length + 3,
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
  it("lists across page boundaries above 1000 keys", async () => {
    const store = await makeStore();
    for (let base = 0; base < 1105; base += 25)
      await Promise.all(
        Array.from({ length: Math.min(25, 1105 - base) }, (_, i) =>
          store.put(`p/${String(base + i).padStart(5, "0")}`, new Uint8Array()),
        ),
      );
    const all: string[] = [];
    let cursor: Awaited<ReturnType<GcsBlobStore["list"]>>["nextCursor"] = null;
    do {
      const page = await store.list("p/", cursor ?? undefined, 1100);
      all.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(1105);
    expect(new Set(all).size).toBe(1105);
  }, 60000);
});
