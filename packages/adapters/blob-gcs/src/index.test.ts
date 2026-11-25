import {
  BlobAccessDeniedError,
  BlobBucketNotFoundError,
  BlobCorruptError,
  BlobPreconditionError,
  BlobThrottledError,
  BlobUnavailableError,
  InvalidCursorError,
} from "@moriyoshi/errtraq-core";
import {
  GcpAuthError,
  ServiceAccountTokenSource,
  staticTokenSource,
} from "@moriyoshi/errtraq-gcp-auth";
import { blobStoreContract } from "@moriyoshi/errtraq-testing";
import { describe, expect, it } from "vitest";
import { Crc32c } from "./crc32c.js";
import { FakeGcs } from "./fake-gcs.test-support.js";
import { create } from "./index.js";
import { GcsBlobStore } from "./runtime.js";
import { configSchema, gcsBlob, infra, manifest } from "./stack.js";

const CHUNK = 256 * 1024;
function make(
  fake = new FakeGcs(),
  extra: Partial<ConstructorParameters<typeof GcsBlobStore>[0]> = {},
) {
  const store = new GcsBlobStore({
    bucket: fake.bucket,
    endpoint: "https://gcs.example.test",
    tokens: staticTokenSource("tok"),
    fetch: fake.fetch,
    sleep: async () => {},
    allowedPrefixes: [""],
    chunkSize: CHUNK,
    ...extra,
  });
  return { fake, store };
}
const bytesOf = async (stream: ReadableStream<Uint8Array> | null) =>
  new Uint8Array(await new Response(stream as ReadableStream).arrayBuffer());
const streamOf = (...parts: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

describe("GCS BlobStore contract (fetch fake)", () => {
  blobStoreContract(async () => make().store);
});

describe("request shapes", () => {
  it("uploads byte arrays with a simple media upload and the bearer token", async () => {
    const { fake, store } = make();
    await store.put("a/b c+é", new Uint8Array([1, 2]), {
      contentType: "text/plain",
      size: 2,
    });
    const [request] = fake.requests;
    expect(request?.url.pathname).toBe("/upload/storage/v1/b/test-bucket/o");
    expect(request?.url.searchParams.get("uploadType")).toBe("media");
    expect(request?.url.searchParams.get("name")).toBe("a/b c+é");
    expect(request?.headers.get("authorization")).toBe("Bearer tok");
    expect(request?.headers.get("content-type")).toBe("text/plain");
    expect(fake.objects.get("a/b c+é")?.contentType).toBe("text/plain");
  });
  it("percent-encodes the whole object name in object URLs", async () => {
    const { fake, store } = make();
    await store.put("p/q?#%", new Uint8Array([7]));
    await store.head("p/q?#%");
    expect(fake.requests[1]?.url.pathname).toBe(
      "/storage/v1/b/test-bucket/o/p%2Fq%3F%23%25",
    );
    expect(await bytesOf(await store.get("p/q?#%"))).toEqual(
      new Uint8Array([7]),
    );
  });
  it("sends no Authorization header without a token (emulator mode)", async () => {
    const fake = new FakeGcs();
    const { store } = make(fake, { tokens: staticTokenSource("") });
    await store.put("k", new Uint8Array());
    expect(fake.requests[0]?.headers.has("authorization")).toBe(false);
  });
  it("rejects size mismatches and keys outside the delivered prefixes", async () => {
    const { store } = make(new FakeGcs(), { allowedPrefixes: ["payloads/"] });
    await expect(
      store.put("payloads/x", new Uint8Array(3), { size: 4 }),
    ).rejects.toThrow("Size mismatch");
    await expect(
      store.put("payloads/x", streamOf(new Uint8Array(3)), { size: 2 }),
    ).rejects.toThrow("Size mismatch");
    await expect(store.put("other/x", new Uint8Array())).rejects.toBeInstanceOf(
      BlobAccessDeniedError,
    );
    await expect(store.list("other/")).rejects.toBeInstanceOf(
      BlobAccessDeniedError,
    );
  });
});

describe("streaming uploads", () => {
  it("sends a short stream as one media upload", async () => {
    const { fake, store } = make();
    await store.put("s", streamOf(new Uint8Array([1]), new Uint8Array([2, 3])));
    expect(
      fake.requests.map((r) => r.url.searchParams.get("uploadType")),
    ).toEqual(["media"]);
    expect(await bytesOf(await store.get("s"))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });
  it("sends an empty stream as an empty object", async () => {
    const { store } = make();
    await store.put("e", streamOf());
    expect((await store.head("e"))?.size).toBe(0);
  });
  it("uses a resumable session with non-final chunks and a final known total", async () => {
    const { fake, store } = make();
    const data = new Uint8Array(CHUNK * 2 + 5).map((_, i) => i % 251);
    await store.put("big", streamOf(data.slice(0, 1000), data.slice(1000)), {
      contentType: "x/y",
      size: data.length,
    });
    const ranges = fake.requests
      .filter((r) => r.method === "PUT")
      .map((r) => r.headers.get("content-range"));
    expect(ranges).toEqual([
      `bytes 0-${CHUNK - 1}/*`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/*`,
      `bytes ${2 * CHUNK}-${2 * CHUNK + 4}/${data.length}`,
    ]);
    const start = fake.requests.find(
      (r) => r.url.searchParams.get("uploadType") === "resumable",
    );
    expect(start?.headers.get("x-upload-content-type")).toBe("x/y");
    expect(start?.headers.get("x-upload-content-length")).toBe(
      String(data.length),
    );
    expect(
      fake.requests
        .filter((r) => r.method === "PUT")
        .every((r) => !r.headers.has("authorization")),
    ).toBe(true);
    expect(await bytesOf(await store.get("big"))).toEqual(data);
    expect(fake.objects.get("big")?.contentType).toBe("x/y");
  });
  it("finalizes with an empty range when the stream ends on a chunk boundary", async () => {
    const { fake, store } = make();
    await store.put("exact", streamOf(new Uint8Array(CHUNK * 2).fill(3)));
    expect(fake.objects.get("exact")?.bytes.length).toBe(CHUNK * 2);
  });
  it("resumes a chunk after a server error by asking for the persisted offset", async () => {
    const fake = new FakeGcs();
    let injected = false;
    fake.intercept = (request) => {
      if (
        request.method === "PUT" &&
        !request.headers.get("content-range")?.startsWith("bytes */") &&
        !injected &&
        request.headers.get("content-range")?.startsWith(`bytes ${CHUNK}-`)
      ) {
        injected = true;
        // Persist half of the chunk, then fail the response.
        const session = [...fake.sessions.values()][0];
        const half = request.body.slice(0, CHUNK / 2);
        session?.received.push(half);
        if (session) session.size += half.length;
        return new Response("boom", { status: 503 });
      }
    };
    const { store } = make(fake);
    const data = new Uint8Array(CHUNK * 2 + 9).map((_, i) => (i * 7) % 256);
    await store.put("r", streamOf(data));
    expect(injected).toBe(true);
    expect(await bytesOf(await store.get("r"))).toEqual(data);
  });
  it("cancels the session and surfaces the error when the source stream fails", async () => {
    const { fake, store } = make();
    let sent = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(CHUNK + 1));
        } else controller.error(new Error("source broke"));
      },
    });
    await expect(store.put("f", failing)).rejects.toThrow("source broke");
    expect(fake.sessions.size).toBe(0);
    expect(fake.objects.has("f")).toBe(false);
  });
  it("refuses an upload session on an unexpected host", async () => {
    const fake = new FakeGcs();
    fake.intercept = (r) =>
      r.method === "POST" &&
      r.url.searchParams.get("uploadType") === "resumable"
        ? new Response(null, {
            headers: { location: "https://evil.example.test/up" },
          })
        : undefined;
    const store = new GcsBlobStore({
      bucket: fake.bucket,
      tokens: staticTokenSource("t"),
      fetch: fake.fetch,
      sleep: async () => {},
      allowedPrefixes: [""],
      chunkSize: CHUNK,
    });
    await expect(
      store.put("x", streamOf(new Uint8Array(CHUNK + 1))),
    ).rejects.toBeInstanceOf(BlobCorruptError);
  });
});

describe("reads", () => {
  it("raises BlobCorruptError when the CRC32C does not match", async () => {
    const { fake, store } = make();
    await store.put("c", new Uint8Array([1, 2, 3]));
    fake.corruptCrc = true;
    await expect(bytesOf(await store.get("c"))).rejects.toBeInstanceOf(
      BlobCorruptError,
    );
    // Ranged reads cannot be checked against the whole-object checksum.
    expect(
      await bytesOf(await store.get("c", { range: { offset: 1 } })),
    ).toEqual(new Uint8Array([2, 3]));
  });
  it("matches the CRC-32C check vector", () => {
    const crc = new Crc32c();
    crc.update(new TextEncoder().encode("123456789"));
    // 0xE3069283 big-endian
    expect(crc.digestBase64()).toBe(
      btoa(String.fromCharCode(0xe3, 0x06, 0x92, 0x83)),
    );
  });
  it("distinguishes a missing bucket from a missing object", async () => {
    const fake = new FakeGcs("other-bucket");
    const store = new GcsBlobStore({
      bucket: "nope",
      endpoint: "https://gcs.example.test",
      tokens: staticTokenSource(""),
      fetch: fake.fetch,
      sleep: async () => {},
      allowedPrefixes: [""],
    });
    await expect(store.get("k")).rejects.toBeInstanceOf(
      BlobBucketNotFoundError,
    );
    await expect(store.head("k")).rejects.toBeInstanceOf(
      BlobBucketNotFoundError,
    );
    await expect(store.delete("k")).rejects.toBeInstanceOf(
      BlobBucketNotFoundError,
    );
    await expect(store.put("k", new Uint8Array())).rejects.toBeInstanceOf(
      BlobBucketNotFoundError,
    );
  });
  it("treats a range past the end as empty and a range on a missing object as null", async () => {
    const { store } = make();
    await store.put("z", new Uint8Array(0));
    expect(
      await bytesOf(await store.get("z", { range: { offset: 10 } })),
    ).toEqual(new Uint8Array());
    expect(await store.get("nope", { range: { offset: 10 } })).toBeNull();
  });
});

describe("listing", () => {
  it("pages beyond 1000 keys with a single opaque cursor per port page", async () => {
    const { fake, store } = make();
    for (let i = 0; i < 2105; i++)
      fake.objects.set(`p/${String(i).padStart(5, "0")}`, {
        bytes: new Uint8Array(),
        contentType: "x",
      });
    fake.requests.length = 0;
    const first = await store.list("p/", undefined, 2500);
    expect(first.items).toHaveLength(2105);
    expect(first.nextCursor).toBeNull();
    expect(
      fake.requests.map((r) => r.url.searchParams.get("maxResults")),
    ).toEqual(["1000", "1000", "500"]);
    const page = await store.list("p/", undefined, 1500);
    expect(page.items).toHaveLength(1500);
    const rest = await store.list("p/", page.nextCursor ?? undefined, 1500);
    expect(rest.items[0]).toBe("p/01500");
    expect(rest.items).toHaveLength(605);
  });
  it("rejects a cursor from another prefix", async () => {
    const { store } = make();
    await store.put("p/1", new Uint8Array());
    await store.put("p/2", new Uint8Array());
    const page = await store.list("p/", undefined, 1);
    await expect(
      store.list("q/", page.nextCursor ?? undefined),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });
  it("fails closed when the listing is out of order", async () => {
    const fake = new FakeGcs();
    fake.intercept = (r) =>
      r.url.pathname.endsWith("/o") && r.method === "GET"
        ? new Response(
            JSON.stringify({ items: [{ name: "b" }, { name: "a" }] }),
          )
        : undefined;
    await expect(make(fake).store.list("")).rejects.toBeInstanceOf(
      BlobCorruptError,
    );
  });
});

describe("retries and error mapping", () => {
  it("retries 503 and network errors on idempotent calls", async () => {
    const fake = new FakeGcs();
    let n = 0;
    fake.intercept = () => {
      n++;
      if (n === 1) return new Response("", { status: 503 });
      if (n === 2) throw new TypeError("network");
      return undefined;
    };
    const { store } = make(fake);
    await store.put("k", new Uint8Array([1]));
    expect(n).toBe(3);
  });
  it("gives up after repeated failures with BlobUnavailableError", async () => {
    const fake = new FakeGcs();
    fake.intercept = () => new Response("", { status: 500 });
    await expect(make(fake).store.head("k")).rejects.toBeInstanceOf(
      BlobUnavailableError,
    );
    expect(fake.requests).toHaveLength(5);
  });
  it.each([
    [403, "forbidden", BlobAccessDeniedError],
    [401, "required", BlobAccessDeniedError],
    [412, "conditionNotMet", BlobPreconditionError],
  ])(
    "maps %i to its typed error without retrying",
    async (status, reason, type) => {
      const fake = new FakeGcs();
      fake.intercept = () =>
        new Response(
          JSON.stringify({ error: { message: "m", errors: [{ reason }] } }),
          { status },
        );
      await expect(
        make(fake).store.put("k", new Uint8Array()),
      ).rejects.toBeInstanceOf(type);
      expect(fake.requests).toHaveLength(1);
    },
  );
  it("maps exhausted 429 to throttling", async () => {
    const fake = new FakeGcs();
    fake.intercept = () => new Response("{}", { status: 429 });
    const failure = await make(fake)
      .store.delete("k")
      .catch((e) => e);
    expect(failure).toBeInstanceOf(BlobThrottledError);
    expect(fake.requests).toHaveLength(5);
    const direct = new FakeGcs();
    direct.intercept = () =>
      new Response(
        JSON.stringify({
          error: { errors: [{ reason: "rateLimitExceeded" }] },
        }),
        { status: 403 },
      );
    await expect(make(direct).store.head("k")).rejects.toBeInstanceOf(
      BlobThrottledError,
    );
  });
  it("maps credential failures", async () => {
    const { store } = make(new FakeGcs(), {
      tokens: {
        getAccessToken: async () => {
          throw new GcpAuthError("denied", "denied");
        },
        getIdToken: async () => "",
      },
    });
    await expect(store.head("k")).rejects.toBeInstanceOf(BlobAccessDeniedError);
  });
});

async function testSigner() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))
    .match(/.{1,64}/g)
    ?.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return {
    pair,
    source: new ServiceAccountTokenSource({
      key: { client_email: "sa@proj.iam.example", private_key: pem },
    }),
  };
}

describe("V4 signed URLs", () => {
  it("builds a canonical request that the signer's key verifies", async () => {
    const { pair, source } = await testSigner();
    const { store } = make(new FakeGcs(), {
      endpoint: undefined,
      signer: source,
      clock: () => Date.UTC(2026, 10, 26, 9, 8, 7, 654),
    });
    const url = new URL(
      (await store.presign?.("a b/ü(1).txt", {
        method: "GET",
        expiresInSec: 600,
      })) as string,
    );
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(url.pathname).toBe("/test-bucket/a%20b/%C3%BC%281%29.txt");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
      "X-Goog-Credential":
        "sa@proj.iam.example/20261126/auto/storage/goog4_request",
      "X-Goog-Date": "20261126T090807Z",
      "X-Goog-Expires": "600",
      "X-Goog-SignedHeaders": "host",
    });
    const signature = url.searchParams.get("X-Goog-Signature") as string;
    // Rebuild the string to sign independently of the adapter and verify the RSA signature.
    const query = [...url.searchParams]
      .filter(([k]) => k !== "X-Goog-Signature")
      .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const canonical = [
      "GET",
      url.pathname,
      query,
      "host:storage.googleapis.com\n",
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      ),
    );
    const toSign = `GOOG4-RSA-SHA256\n20261126T090807Z\n20261126/auto/storage/goog4_request\n${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    const raw = Uint8Array.from(signature.match(/../g) ?? [], (h) =>
      Number.parseInt(h, 16),
    );
    expect(
      await crypto.subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        pair.publicKey,
        raw,
        new TextEncoder().encode(toSign),
      ),
    ).toBe(true);
  });
  it("signs PUT URLs, rejects bad lifetimes, and is absent without a signer", async () => {
    const { source } = await testSigner();
    const { store } = make(new FakeGcs(), { signer: source });
    expect(
      await store.presign?.("k", { method: "PUT", expiresInSec: 604800 }),
    ).toContain("X-Goog-Expires=604800");
    await expect(
      store.presign?.("k", { method: "GET", expiresInSec: 604801 }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      store.presign?.("k", { method: "GET", expiresInSec: 0 }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(make().store.presign).toBeUndefined();
  });
});

describe("stack and create", () => {
  const bindings = { ERRTRAQ_BLOB_BUCKET: "b" };
  it("requires an explicit location and defaults auth to the metadata server", () => {
    expect(configSchema.safeParse({}).success).toBe(false);
    expect(configSchema.parse({ location: "somewhere" }).auth).toEqual({
      mode: "metadata",
    });
    expect(manifest).toMatchObject({ id: "blob-gcs", kind: "blob" });
  });
  it("describes the gcs module with location passed through", () => {
    const selection = gcsBlob({ location: "loc-1" });
    expect(selection.runtimeModule).toBe("@moriyoshi/errtraq-blob-gcs/runtime");
    expect(infra.module).toMatchObject({
      provider: "google",
      component: "gcs",
    });
    expect(infra.inputs({ location: "loc-1" }, {} as never)).toMatchObject({
      location: "loc-1",
    });
    expect(infra.inputs({ location: "loc-1" }, {} as never)).not.toHaveProperty(
      "staging_prefix",
    );
    expect(Object.keys(infra.capabilities)).toEqual([
      "read",
      "write",
      "delete",
      "list",
    ]);
    expect(infra.bindings.map((b) => b.name)).toEqual(["ERRTRAQ_BLOB_BUCKET"]);
  });
  it("creates a store from bindings and refuses unsafe or incomplete setups", () => {
    const config = configSchema.parse({ location: "l" });
    expect(create({ config, bindings, dependencies: {} })).toBeInstanceOf(
      GcsBlobStore,
    );
    expect(() => create({ config, bindings: {}, dependencies: {} })).toThrow(
      /bucket binding/,
    );
    expect(() =>
      create({
        config: configSchema.parse({ location: "l", auth: { mode: "none" } }),
        bindings,
        dependencies: {},
      }),
    ).toThrow(/endpoint/);
  });
  it("reads a service account key from the secret source only when first used", async () => {
    const reads: string[] = [];
    const config = configSchema.parse({
      location: "l",
      auth: { mode: "service-account", keySecretId: "sec-1" },
    });
    const store = create({
      config,
      bindings,
      dependencies: {},
      secretSource: {
        read: async (id) => {
          reads.push(id);
          return "not json";
        },
      },
    });
    expect(reads).toEqual([]);
    await expect(store.head("envelopes/x")).rejects.toThrow();
    expect(reads).toEqual(["sec-1"]);
    expect(store.presign).toBeDefined();
  });
  it("uses a static token from the environment", async () => {
    const fake = new FakeGcs();
    const config = configSchema.parse({
      location: "l",
      endpoint: "https://gcs.example.test",
      auth: { mode: "static", tokenEnv: "T" },
    });
    const store = create({
      config,
      bindings: { ERRTRAQ_BLOB_BUCKET: fake.bucket },
      dependencies: {},
      environment: { T: "from-env" },
    });
    // Route the adapter's fetch through the fake.
    (store as unknown as { fetcher: typeof fetch }).fetcher = fake.fetch;
    await store.put("payloads/x", new Uint8Array([1]));
    expect(fake.requests[0]?.headers.get("authorization")).toBe(
      "Bearer from-env",
    );
  });
});
