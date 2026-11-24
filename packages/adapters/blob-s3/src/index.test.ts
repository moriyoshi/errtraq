import {
  BlobAccessDeniedError,
  BlobBucketNotFoundError,
  BlobCorruptError,
  BlobError,
  BlobInvalidKeyError,
  BlobPreconditionError,
  BlobThrottledError,
  BlobUnavailableError,
  InvalidCursorError,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it, vi } from "vitest";
import { create } from "./index.js";
import { S3BlobStore, signS3Request } from "./runtime.js";

const creds = { accessKeyId: "test-access", secretAccessKey: "test-secret" };
function store(fetcher: typeof fetch) {
  return new S3BlobStore({
    allowedPrefixes: [""],
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
      allowedPrefixes: [""],
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
      await s3.delete("envelopes/a");
      vi.stubEnv("AWS_ACCESS_KEY_ID", "key-two");
      vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret-two");
      vi.stubEnv("AWS_SESSION_TOKEN", "token-two");
      await s3.delete("envelopes/b");
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
      await s3.delete("envelopes/key");
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
      allowedPrefixes: [""],
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
  it("times out and aborts each stalled request attempt", async () => {
    const signals: AbortSignal[] = [];
    const s3 = new S3BlobStore({
      allowedPrefixes: [""],
      bucket: "b",
      region: "us-east-1",
      credentials: () => creds,
      requestTimeoutMs: 10,
      random: () => 0,
      sleep: async () => {},
      fetch: async (_url, init) => {
        const signal = init?.signal;
        if (signal) signals.push(signal);
        return await new Promise<Response>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
    });
    await expect(s3.get("a")).rejects.toBeInstanceOf(BlobUnavailableError);
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it("times out and aborts an idle response body", async () => {
    let aborted = false;
    const s3 = new S3BlobStore({
      allowedPrefixes: [""],
      bucket: "b",
      region: "us-east-1",
      credentials: () => creds,
      bodyIdleTimeoutMs: 10,
      fetch: async (_url, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
          }),
        );
      },
    });
    const body = await s3.get("a");
    await expect(new Response(body).arrayBuffer()).rejects.toBeInstanceOf(
      BlobUnavailableError,
    );
    expect(aborted).toBe(true);
  });
  it("uses full jitter and honors Retry-After", async () => {
    const waits: number[] = [];
    let calls = 0;
    const s3 = new S3BlobStore({
      allowedPrefixes: [""],
      bucket: "b",
      region: "us-east-1",
      credentials: () => creds,
      random: () => 0.4,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async () => {
        calls++;
        return calls === 1
          ? new Response(null, { status: 503, headers: { "retry-after": "2" } })
          : calls === 2
            ? new Response(null, { status: 429 })
            : new Response(null, { status: 204 });
      },
    });
    await s3.delete("a");
    expect(waits).toEqual([2000, 400]);
  });
  it("honors an HTTP-date Retry-After", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const waits: number[] = [];
    let calls = 0;
    try {
      const s3 = new S3BlobStore({
        allowedPrefixes: [""],
        bucket: "b",
        region: "us-east-1",
        credentials: () => creds,
        random: () => 0,
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetch: async () =>
          ++calls === 1
            ? new Response(null, {
                status: 503,
                headers: {
                  "retry-after": new Date(1_700_000_003_000).toUTCString(),
                },
              })
            : new Response(null, { status: 204 }),
      });
      await s3.delete("a");
      expect(waits).toEqual([3000]);
    } finally {
      now.mockRestore();
    }
  });
  it("does not shorten a long Retry-After to the timer maximum", async () => {
    const waits: number[] = [];
    let calls = 0;
    const s3 = new S3BlobStore({
      allowedPrefixes: [""],
      bucket: "b",
      region: "us-east-1",
      credentials: () => creds,
      random: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async () =>
        ++calls === 1
          ? new Response(null, {
              status: 503,
              headers: { "retry-after": "3000000" },
            })
          : new Response(null, { status: 204 }),
    });
    await s3.delete("a");
    expect(waits).toEqual([3_000_000_000]);
  });
  it("refreshes credentials once for ExpiredToken and preserves the second error", async () => {
    const auth: string[] = [];
    let credentials = 0;
    const s3 = new S3BlobStore({
      allowedPrefixes: [""],
      bucket: "b",
      region: "us-east-1",
      credentials: () => ({
        accessKeyId: `key-${++credentials}`,
        secretAccessKey: "secret",
      }),
      fetch: async (_url, init) => {
        auth.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response("<Error><Code>ExpiredToken</Code></Error>", {
          status: 403,
        });
      },
    });
    await expect(s3.delete("a")).rejects.toMatchObject({
      providerCode: "ExpiredToken",
    });
    expect(auth).toHaveLength(2);
    expect(auth[0]).toContain("Credential=key-1/");
    expect(auth[1]).toContain("Credential=key-2/");
  });
  it("uses signed SHA-256 payload hashes on byte puts and multipart parts", async () => {
    const hashes: string[] = [];
    const s3 = store(async (url, init) => {
      const headers = new Headers(init?.headers);
      if (init?.method === "PUT") {
        const body = init.body as Uint8Array;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          body as Uint8Array<ArrayBuffer>,
        );
        const actual = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        expect(headers.get("x-amz-content-sha256")).toBe(actual);
        expect(headers.get("authorization")).toContain("x-amz-content-sha256");
        hashes.push(actual);
        return new Response(null, { headers: { etag: '"etag"' } });
      }
      if (String(url).includes("uploads="))
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>",
        );
      return new Response(
        "<CompleteMultipartUploadResult><ETag>ok</ETag></CompleteMultipartUploadResult>",
      );
    });
    await s3.put("a", new Uint8Array([1, 2, 3]));
    await s3.put(
      "a",
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
          c.close();
        },
      }),
    );
    expect(hashes).toHaveLength(3);
  });
  it("decodes S3 form-style spaces and encoded literal plus signs", async () => {
    const response =
      "<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated><Contents><Key>p%2Fa+b</Key></Contents><Contents><Key>p%2Fa%2Bb</Key></Contents></ListBucketResult>";
    expect(
      (await store(async () => new Response(response)).list("p/")).items,
    ).toEqual(["p/a b", "p/a+b"]);
  });
  it("limits operations to delivered primary and staging purposes", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      calls.push(String(url));
      return new Response(
        "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
      );
    });
    try {
      const base = {
        config: { region: "us-east-1" },
        dependencies: {},
        environment: { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" },
      };
      const primary = create({
        ...base,
        bindings: { ERRTRAQ_BLOB_BUCKET: "bucket" },
      });
      await expect(primary.list("")).rejects.toBeInstanceOf(
        BlobAccessDeniedError,
      );
      await expect(primary.delete("archive-staging/a")).rejects.toBeInstanceOf(
        BlobAccessDeniedError,
      );
      await primary.list("envelopes/");
      const staging = create({
        ...base,
        bindings: {
          ERRTRAQ_STAGING_BUCKET: "bucket",
          ERRTRAQ_STAGING_PREFIX: "archive-staging/",
        },
      });
      await expect(staging.list("envelopes/")).rejects.toBeInstanceOf(
        BlobAccessDeniedError,
      );
      await expect(
        staging.delete("archive-staging-evil/a"),
      ).rejects.toBeInstanceOf(BlobAccessDeniedError);
      await staging.list("archive-staging/");
      await staging.put("archive-staging/item", new Uint8Array([1]));
      const both = create({
        ...base,
        bindings: {
          ERRTRAQ_BLOB_BUCKET: "bucket",
          ERRTRAQ_STAGING_BUCKET: "bucket",
          ERRTRAQ_STAGING_PREFIX: "archive-staging/",
        },
      });
      await both.list("archive-staging/");
      expect(calls).toHaveLength(4);
      expect(() =>
        create({ ...base, bindings: { ERRTRAQ_STAGING_BUCKET: "bucket" } }),
      ).toThrow("prefix");
      expect(() =>
        create({
          ...base,
          bindings: {
            ERRTRAQ_STAGING_BUCKET: "bucket",
            ERRTRAQ_STAGING_PREFIX: "archive-staging",
          },
        }),
      ).toThrow("prefix");
      expect(() =>
        create({
          ...base,
          bindings: {
            ERRTRAQ_BLOB_BUCKET: "one",
            ERRTRAQ_STAGING_BUCKET: "two",
            ERRTRAQ_STAGING_PREFIX: "archive-staging/",
          },
        }),
      ).toThrow("same bucket");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("denies unconfigured runtime purposes before making a request", async () => {
    const request = vi.fn();
    const s3 = new S3BlobStore({
      bucket: "bucket",
      region: "us-east-1",
      credentials: () => creds,
      fetch: request,
    });
    await expect(s3.list("envelopes/")).rejects.toBeInstanceOf(
      BlobAccessDeniedError,
    );
    await expect(s3.delete("envelopes/key")).rejects.toBeInstanceOf(
      BlobAccessDeniedError,
    );
    expect(request).not.toHaveBeenCalled();
  });
  it("cancels a response body and releases its reader", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const s3 = store(
      async () => new Response(stream, { headers: { "content-length": "5" } }),
    );
    const body = await s3.get("a");
    if (!body) throw new Error("missing body");
    await body.cancel();
    expect(canceled).toBe(true);
    expect(stream.locked).toBe(false);
  });
  it("puts small and empty streams directly, without multipart or abort permission", async () => {
    const calls: string[] = [];
    const s3 = store(async (_url, init) => {
      calls.push(String(init?.method));
      return new Response(null, { status: 200 });
    });
    for (const bytes of [new Uint8Array(), new Uint8Array([1, 2, 3])]) {
      await s3.put(
        "a",
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
    }
    expect(calls).toEqual(["PUT", "PUT"]);
  });
  it("reports both an upload failure and an abort denial", async () => {
    const s3 = store(async (url, init) => {
      if (init?.method === "POST" && String(url).includes("uploads="))
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>",
        );
      return new Response("<Error><Code>AccessDenied</Code></Error>", {
        status: 403,
      });
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    const failure = await s3.put("a", body).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors[1]).toBeInstanceOf(
      BlobAccessDeniedError,
    );
  });
  it("preserves an embedded multipart completion error code", async () => {
    const s3 = store(async (url, init) => {
      if (init?.method === "POST" && String(url).includes("uploads="))
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>",
        );
      if (init?.method === "PUT")
        return new Response(null, { headers: { etag: '"part"' } });
      if (init?.method === "POST")
        return new Response("<Error><Code>SlowDown</Code></Error>");
      return new Response(null, { status: 204 });
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    await expect(s3.put("a", body)).rejects.toMatchObject({
      name: "BlobThrottledError",
      providerCode: "SlowDown",
    });
  });
  it("reports a missing bucket instead of treating it as a missing object", async () => {
    const s3 = store(
      async () =>
        new Response("<Error><Code>NoSuchBucket</Code></Error>", {
          status: 404,
        }),
    );
    await expect(s3.get("a")).rejects.toBeInstanceOf(BlobBucketNotFoundError);
    await expect(s3.head("a")).rejects.toBeInstanceOf(BlobBucketNotFoundError);
    await expect(
      store(
        async () =>
          new Response(null, {
            status: 404,
            headers: { "x-amz-error-code": "NoSuchBucket" },
          }),
      ).head("a"),
    ).rejects.toBeInstanceOf(BlobBucketNotFoundError);
    expect(
      await store(
        async () =>
          new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
          }),
      ).get("a"),
    ).toBeNull();
    expect(
      await store(async () => new Response(null, { status: 404 })).head("a"),
    ).toBeNull();
  });
  it("maps provider failures to typed errors and preserves provider codes", async () => {
    for (const [status, code, kind] of [
      [403, "AccessDenied", BlobAccessDeniedError],
      [429, "SlowDown", BlobThrottledError],
      [412, "PreconditionFailed", BlobPreconditionError],
      [400, "InvalidArgument", BlobInvalidKeyError],
      [503, "ServiceUnavailable", BlobUnavailableError],
      [301, "PermanentRedirect", BlobError],
    ] as const) {
      const s3 = store(
        async () =>
          new Response(`<Error><Code>${code}</Code></Error>`, { status }),
      );
      const error = await s3
        .put("a", new Uint8Array())
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(kind);
      expect(error).toMatchObject({ providerCode: code });
      if (status === 301)
        expect(String(error)).toContain("region and endpoint");
    }
  });
  it("retains the original clock-skew or access error when disambiguation fails", async () => {
    let calls = 0;
    const skew = store(async () => {
      calls++;
      return new Response("<Error><Code>RequestTimeTooSkewed</Code></Error>", {
        status: 403,
      });
    });
    await expect(skew.get("a")).rejects.toMatchObject({
      providerCode: "RequestTimeTooSkewed",
    });
    expect(calls).toBe(1);
    const denied = store(async (url) =>
      String(url).includes("list-type=2")
        ? new Response("<Error><Code>Other</Code></Error>", { status: 403 })
        : new Response("<Error><Code>AccessDenied</Code></Error>", {
            status: 403,
          }),
    );
    await expect(denied.get("a")).rejects.toMatchObject({
      providerCode: "AccessDenied",
    });
  });
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
      allowedPrefixes: [""],
      bucket: "bucket",
      region: "us-east-1",
      credentials: () => creds,
      fetch: request,
      random: () => 0.5,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await s3.delete("x");
    expect(count).toBe(4);
    expect(waits).toEqual([250, 500, 1000]);
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
      await expect(s3.delete(key)).rejects.toBeInstanceOf(BlobInvalidKeyError);
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
            controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
            controller.enqueue(new Uint8Array(2));
            controller.close();
          },
        }),
        { size: 5 * 1024 * 1024 + 1 },
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
      allowedPrefixes: [""],
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
