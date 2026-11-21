import { BlobCorruptError, InvalidCursorError } from "@errtraq/core";
import { describe, expect, it, vi } from "vitest";
import { create } from "./index.js";
import { S3BlobStore, signS3Request } from "./runtime.js";

const creds = { accessKeyId: "test-access", secretAccessKey: "test-secret" };
function store(fetcher: typeof fetch) {
  return new S3BlobStore({
    bucket: "bucket",
    region: "us-east-1",
    endpoint: "https://storage.example.test",
    forcePathStyle: true,
    credentials: () => creds,
    fetch: fetcher,
    sleep: async () => {},
  });
}
const listing = (keys: string[], truncated = false) =>
  `<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>${truncated}</IsTruncated>${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join("")}</ListBucketResult>`;

describe("S3 request signing", () => {
  it("matches the published AWS S3 GET signing vector", async () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
    // AWS's published example credentials are documentation fixtures, not real credentials.
    const signed = await signS3Request({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      service: "s3",
      region: "us-east-1",
      datetime: "20130524T000000Z",
      allHeaders: true,
      headers: {
        range: "bytes=0-9",
        "x-amz-content-sha256":
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    });
    expect(signed.headers.get("authorization")).toContain(
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
  it("matches the published AWS S3 presigned GET vector", async () => {
    const signed = await signS3Request({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Expires=86400",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      service: "s3",
      region: "us-east-1",
      datetime: "20130524T000000Z",
      signQuery: true,
    });
    expect(signed.url.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });
  it("refreshes credentials and passes a session token on each request", async () => {
    let n = 0;
    const request = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const s3 = new S3BlobStore({
      bucket: "bucket",
      region: "us-east-1",
      credentials: () => ({ ...creds, sessionToken: `token-${++n}` }),
      fetch: request,
    });
    await s3.delete("a");
    await s3.delete("b");
    expect(
      new Headers(request.mock.calls[0]?.[1]?.headers).get(
        "x-amz-security-token",
      ),
    ).toBe("token-1");
    expect(
      new Headers(request.mock.calls[1]?.[1]?.headers).get(
        "x-amz-security-token",
      ),
    ).toBe("token-2");
  });
  it("uses and refreshes standard Lambda environment credentials", async () => {
    const headers: Headers[] = [];
    vi.stubEnv("AWS_REGION", "us-west-2");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "key-one");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret-one");
    vi.stubEnv("AWS_SESSION_TOKEN", "token-one");
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      return new Response(null, { status: 204 });
    });
    try {
      const s3 = create({
        config: {},
        bindings: { ERRTRAQ_BLOB_BUCKET: "bucket" },
        dependencies: {},
        environment: process.env,
      });
      await s3.delete("a");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "key-two");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret-two");
      vi.stubEnv("AWS_SESSION_TOKEN", "token-two");
      await s3.delete("b");
      expect(headers[0]?.get("authorization")).toContain("Credential=key-one/");
      expect(headers[1]?.get("authorization")).toContain("Credential=key-two/");
      expect(headers[1]?.get("x-amz-security-token")).toBe("token-two");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
  it("accepts explicit Web runtime credential bindings", async () => {
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      requests.push(new Headers(init.headers));
      return new Response(null, { status: 204 });
    });
    try {
      const s3 = create({
        config: { region: "us-east-1" },
        bindings: {
          ERRTRAQ_BLOB_BUCKET: "bucket",
          AWS_ACCESS_KEY_ID: "worker-key",
          AWS_SECRET_ACCESS_KEY: "worker-secret",
          AWS_SESSION_TOKEN: "worker-token",
        },
        dependencies: {},
      });
      await s3.delete("key");
      expect(requests[0]?.get("authorization")).toContain(
        "Credential=worker-key/",
      );
      expect(requests[0]?.get("x-amz-security-token")).toBe("worker-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("uses path-style or virtual-hosted addressing", async () => {
    const urls: string[] = [];
    const request: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(null, { status: 204 });
    };
    await store(request).delete("a b/c");
    await new S3BlobStore({
      bucket: "bucket",
      region: "us-east-1",
      endpoint: "https://storage.example.test",
      credentials: () => creds,
      fetch: request,
    }).delete("a b/c");
    expect(urls).toEqual([
      "https://storage.example.test/bucket/a%20b/c",
      "https://bucket.storage.example.test/a%20b/c",
    ]);
  });
});

describe("S3 error handling and streaming", () => {
  it("distinguishes an absent key from a denied existing key using scoped list", async () => {
    for (const [keys, expected] of [
      [[], null],
      [["envelopes/key"], "denied"],
    ] as const) {
      const request: typeof fetch = async (input) =>
        String(input).includes("list-type=2")
          ? new Response(listing([...keys]))
          : new Response(null, { status: 403 });
      const result = store(request).head("envelopes/key");
      if (expected === null) expect(await result).toBeNull();
      else await expect(result).rejects.toThrow("403");
    }
    const denied: typeof fetch = async () =>
      new Response(null, { status: 403 });
    await expect(store(denied).get("envelopes/key")).rejects.toThrow("403");
  });
  it("retries throttling and server errors with a bounded budget", async () => {
    let count = 0;
    const waits: number[] = [];
    const request: typeof fetch = async () => {
      count++;
      return new Response(null, { status: count < 4 ? 503 : 204 });
    };
    const s3 = new S3BlobStore({
      bucket: "bucket",
      region: "us-east-1",
      credentials: () => creds,
      fetch: request,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await s3.delete("x");
    expect(count).toBe(4);
    expect(waits).toEqual([50, 100, 200]);
    count = 0;
    const always: typeof fetch = async () => {
      count++;
      return new Response(null, { status: 503 });
    };
    await expect(store(always).delete("x")).rejects.toThrow("503");
    expect(count).toBe(4);
  });
  it("rejects object keys that Web URL handling would change", async () => {
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const s3 = store(request);
    for (const key of ["", "a/./b", "a/../b"])
      await expect(s3.delete(key)).rejects.toThrow("cannot be represented");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects ignored byte ranges and malformed cursors", async () => {
    await expect(
      store(async () => new Response("whole")).get("x", {
        range: { offset: 1, length: 1 },
      }),
    ).rejects.toBeInstanceOf(BlobCorruptError);
    await expect(
      store(async () => new Response()).list("x", "invalid" as never),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });
  it("decodes URL-encoded listing keys without losing literal percent signs", async () => {
    const s3 = store(async () => new Response(listing(["p/100%/😀"])));
    expect((await s3.list("p/")).items).toEqual(["p/100%/😀"]);
  });
  it("fails on non-advancing listings rather than looping", async () => {
    const s3 = store(async () => new Response(listing(["p/a"], true)));
    const page = await s3.list("p/", undefined, 1);
    await expect(
      s3.list("p/", page.nextCursor ?? undefined, 1),
    ).rejects.toBeInstanceOf(BlobCorruptError);
  });
  it("detects a wrong content range or a truncated response body", async () => {
    const wrong = store(
      async () =>
        new Response("x", {
          status: 206,
          headers: { "content-range": "bytes 2-2/3", "content-length": "1" },
        }),
    );
    await expect(
      wrong.get("key", { range: { offset: 1, length: 1 } }),
    ).rejects.toBeInstanceOf(BlobCorruptError);
    const truncated = store(
      async () => new Response("x", { headers: { "content-length": "2" } }),
    );
    const stream = await truncated.get("key");
    await expect(new Response(stream).arrayBuffer()).rejects.toBeInstanceOf(
      BlobCorruptError,
    );
  });
  it("returns an empty stream for zero-length or out-of-bounds ranges after checking existence", async () => {
    const request: typeof fetch = async (_url, init) =>
      init?.method === "HEAD"
        ? new Response(null, { headers: { "content-length": "3" } })
        : new Response(null, { status: 416 });
    const s3 = store(request);
    for (const range of [{ offset: 0, length: 0 }, { offset: 20 }]) {
      const stream = await s3.get("a", { range });
      expect(stream).not.toBeNull();
      expect(await new Response(stream).arrayBuffer()).toHaveProperty(
        "byteLength",
        0,
      );
    }
  });
  it("uses bounded multipart parts and aborts after a size mismatch", async () => {
    const calls: { method: string; url: string; bytes: number }[] = [];
    const request: typeof fetch = async (input, init) => {
      const url = String(input),
        method = init?.method ?? "GET",
        body = init?.body;
      calls.push({
        method,
        url,
        bytes: body instanceof Uint8Array ? body.length : 0,
      });
      if (method === "POST" && url.includes("uploads="))
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>",
        );
      if (method === "PUT" && url.includes("partNumber="))
        return new Response(null, { headers: { etag: '"part"' } });
      if (method === "POST" && url.includes("uploadId="))
        return new Response(
          "<CompleteMultipartUploadResult><ETag>done</ETag></CompleteMultipartUploadResult>",
        );
      return new Response(null, { status: 204 });
    };
    const s3 = store(request);
    const bytes = new Uint8Array(5 * 1024 * 1024 + 3);
    await s3.put(
      "a",
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
    expect(
      calls.filter((call) => call.method === "PUT").map((call) => call.bytes),
    ).toEqual([5 * 1024 * 1024, 3]);
    calls.length = 0;
    await expect(
      s3.put(
        "a",
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
            controller.close();
          },
        }),
        { size: 1 },
      ),
    ).rejects.toThrow("Size mismatch");
    expect(
      calls.some(
        (call) => call.method === "DELETE" && call.url.includes("uploadId="),
      ),
    ).toBe(true);
  });
  it("presigns with the temporary session token", async () => {
    const s3 = new S3BlobStore({
      bucket: "bucket",
      region: "us-east-1",
      credentials: () => ({ ...creds, sessionToken: "token" }),
    });
    const url = new URL(
      await s3.presign("key", { method: "GET", expiresInSec: 60 }),
    );
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("token");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects an absent deployed bucket binding", () => {
    expect(() =>
      create({ config: {}, bindings: {}, dependencies: {} }),
    ).toThrow("bucket");
  });
});
