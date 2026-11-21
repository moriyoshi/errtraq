import { describe, expect, it } from "vitest";
import {
  AwsRequestError,
  type AwsRequestOptions,
  awsRequest,
  signAwsRequest,
  signRdsAuthToken,
} from "./index.js";

const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const base = (
  overrides: Partial<AwsRequestOptions> = {},
): AwsRequestOptions => ({
  service: "sqs",
  region: "us-east-1",
  url: "https://example.test/",
  method: "POST",
  credentials: () => credentials,
  protocol: "json",
  sleep: async () => {},
  random: () => 0,
  ...overrides,
});
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers });
describe("AWS SigV4 vectors", () => {
  it("matches the AWS IAM ListUsers example", async () => {
    const signed = await signAwsRequest({
      ...credentials,
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      region: "us-east-1",
      service: "iam",
      datetime: "20150830T123600Z",
      allHeaders: true,
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
    });
    expect(signed.headers.get("authorization")).toContain(
      "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
  it("matches AWS signing test suite get-vanilla", async () => {
    const signed = await signAwsRequest({
      ...credentials,
      method: "GET",
      url: "https://example.amazonaws.com/",
      region: "us-east-1",
      service: "service",
      datetime: "20150830T123600Z",
    });
    expect(signed.headers.get("authorization")).toContain(
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});
describe("RDS IAM token", () => {
  it("matches an independently computed SigV4 vector with temporary credentials", async () => {
    // Expected signature was computed with Python hashlib/hmac and the canonical AWS SigV4 algorithm;
    // the independent implementation was cross-checked against aws rds generate-db-auth-token offline.
    const token = await signRdsAuthToken({
      host: "db.example.us-east-1.rds.amazonaws.com",
      port: 5432,
      user: "user+test",
      region: "us-east-1",
      datetime: "20240102T030405Z",
      credentials: { ...credentials, sessionToken: "TOKEN/+example=" },
    });
    const url = new URL(`https://${token}`);
    expect(url.host).toBe("db.example.us-east-1.rds.amazonaws.com:5432");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      Action: "connect",
      DBUser: "user+test",
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": "AKIDEXAMPLE/20240102/us-east-1/rds-db/aws4_request",
      "X-Amz-Date": "20240102T030405Z",
      "X-Amz-Expires": "900",
      "X-Amz-Security-Token": "TOKEN/+example=",
      "X-Amz-SignedHeaders": "host",
      "X-Amz-Signature":
        "49c449c80a85ed863d9c0bf0f9fd54f9ca4821df406c1b465937148efdf3b9ec",
    });
  });
  it("rejects invalid hosts and empty credentials", async () => {
    for (const host of ["host/path", "host:5432", "", "a..b"]) {
      await expect(
        signRdsAuthToken({
          host,
          port: 5432,
          user: "u",
          region: "r",
          credentials,
        }),
      ).rejects.toThrow("Invalid RDS");
    }
    await expect(
      signRdsAuthToken({
        host: "db.example",
        port: 5432,
        user: "u",
        region: "r",
        credentials: { accessKeyId: "", secretAccessKey: "" },
      }),
    ).rejects.toThrow("Invalid RDS");
  });
});
describe("shared AWS request", () => {
  it("retries transport failures with the default cancellable backoff", async () => {
    let calls = 0;
    const options = {
      ...base({
        random: () => 0,
        fetch: async () => {
          if (++calls === 1) throw new Error("private transport detail");
          return json({ ok: true });
        },
      }),
      sleep: undefined,
    };
    expect(await (await awsRequest(options)).json()).toEqual({ ok: true });
    expect(calls).toBe(2);
    const failure = await awsRequest({
      ...options,
      fetch: async () => {
        throw new Error("private transport detail");
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "NetworkError", retryable: true });
    expect(String(failure)).not.toContain("private transport detail");
  });
  it("retries SQS 400 throttling with full jitter and Retry-After", async () => {
    let calls = 0;
    const waits: number[] = [];
    const response = await awsRequest(
      base({
        random: () => 0.5,
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetch: async () =>
          ++calls === 1
            ? json({ __type: "com.aws#RequestThrottled" }, 400, {
                "Retry-After": "2",
              })
            : ++calls === 3
              ? json({ __type: "OverLimit" }, 400)
              : json({ ok: true }),
      }),
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(waits).toEqual([2000, 500]);
  });
  it("parses JSON, query-header and XML codes and retains typed metadata", async () => {
    for (const [service, protocol, response, code] of [
      [
        "dynamodb",
        "json",
        json({ __type: "com.aws#ConditionalCheckFailedException" }, 400),
        "ConditionalCheckFailedException",
      ],
      [
        "sqs",
        "json",
        new Response("not-json", {
          status: 400,
          headers: {
            "x-amzn-query-error":
              "AWS.SimpleQueueService.NonExistentQueue;Sender",
          },
        }),
        "AWS.SimpleQueueService.NonExistentQueue",
      ],
      [
        "s3",
        "s3",
        new Response("<Error><Code>NoSuchBucket</Code></Error>", {
          status: 404,
        }),
        "NoSuchBucket",
      ],
    ] as const) {
      const error = await awsRequest(
        base({ service, protocol, fetch: async () => response }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AwsRequestError);
      expect(error).toMatchObject({
        service,
        code,
        status: response.status,
        retryable: false,
      });
    }
  });
  it("classifies service-specific throttles as retryable even on HTTP 400", async () => {
    for (const [service, code] of [
      ["sqs", "RequestThrottled"],
      ["sqs", "ThrottlingException"],
      ["sqs", "OverLimit"],
      ["dynamodb", "ProvisionedThroughputExceededException"],
      ["dynamodb", "ThrottlingException"],
      ["dynamodb", "RequestLimitExceeded"],
      ["s3", "SlowDown"],
    ] as const) {
      let calls = 0;
      const protocol = service === "s3" ? "s3" : "json";
      const error = await awsRequest(
        base({
          service,
          protocol,
          fetch: async () => {
            calls++;
            return protocol === "s3"
              ? new Response(`<Error><Code>${code}</Code></Error>`, {
                  status: 400,
                })
              : json({ __type: `x#${code}` }, 400);
          },
        }),
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({
        service,
        code,
        status: 400,
        retryable: true,
      });
      expect(calls).toBe(4);
    }
  });
  it("prefers the query error header over a generic JSON sender code", async () => {
    let calls = 0;
    const result = await awsRequest(
      base({
        fetch: async () =>
          ++calls === 1
            ? json({ code: "Sender" }, 400, {
                "x-amzn-query-error": "RequestThrottled;Sender",
              })
            : json({ ok: true }),
      }),
    );
    expect(await result.json()).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
  it("stops a Retry-After wait at the overall deadline", async () => {
    const started = Date.now();
    await expect(
      awsRequest({
        ...base({
          overallTimeoutMs: 20,
          fetch: async () =>
            json({ __type: "RequestThrottled" }, 400, { "Retry-After": "30" }),
        }),
        sleep: undefined,
      }),
    ).rejects.toMatchObject({ code: "Timeout", retryable: true });
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("re-reads credentials once for ExpiredToken", async () => {
    let reads = 0;
    const auth: string[] = [];
    const options = base({
      credentials: () => ({ ...credentials, accessKeyId: `key${++reads}` }),
      fetch: async (_url, init) => {
        auth.push(new Headers(init?.headers).get("authorization") ?? "");
        return auth.length === 1
          ? json({ __type: "ExpiredTokenException" }, 403)
          : json({ ok: true });
      },
    });
    expect((await (await awsRequest(options)).json()).ok).toBe(true);
    expect(reads).toBe(2);
    expect(auth[1]).toContain("Credential=key2/");
  });
  it("bounds attempts and the whole request and aborts hung fetch", async () => {
    const signals: AbortSignal[] = [];
    const error = await awsRequest(
      base({
        requestTimeoutMs: 100,
        overallTimeoutMs: 10,
        fetch: async (_url, init) => {
          if (init?.signal) signals.push(init.signal);
          return await new Promise<Response>(() => {});
        },
      }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AwsRequestError);
    expect(error).toMatchObject({
      service: "sqs",
      code: "Timeout",
      retryable: true,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });
  it("honors caller cancellation", async () => {
    const abort = new AbortController();
    let used: AbortSignal | undefined;
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = awsRequest(
      base({
        signal: abort.signal,
        fetch: async (_url, init) => {
          used = init?.signal ?? undefined;
          markStarted();
          return await new Promise<Response>(() => {});
        },
      }),
    );
    await started;
    abort.abort();
    await expect(pending).rejects.toMatchObject({
      code: "Aborted",
      retryable: false,
    });
    expect(used?.aborted).toBe(true);
  });
  it("enforces the overall deadline while consuming a streaming body", async () => {
    let signal: AbortSignal | undefined;
    const response = await awsRequest(
      base({
        service: "s3",
        protocol: "s3",
        overallTimeoutMs: 30,
        bodyIdleTimeoutMs: 1000,
        fetch: async (_url, init) => {
          signal = init?.signal ?? undefined;
          return new Response(
            new ReadableStream({
              pull() {
                return new Promise(() => {});
              },
            }),
          );
        },
      }),
    );
    await expect(response.text()).rejects.toMatchObject({
      service: "s3",
      code: "Timeout",
      retryable: true,
    });
    expect(signal?.aborted).toBe(true);
  });
  it("redacts provider error codes that contain credentials", async () => {
    const error = await awsRequest(
      base({
        fetch: async () =>
          json(
            {
              __type: credentials.accessKeyId,
              message: credentials.secretAccessKey,
            },
            400,
          ),
      }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      service: "sqs",
      code: undefined,
      status: 400,
    });
    expect(String(error)).not.toContain(credentials.accessKeyId);
    expect(String(error)).not.toContain(credentials.secretAccessKey);
  });
  it("returns a typed error for malformed successful JSON", async () => {
    await expect(
      awsRequest(base({ fetch: async () => new Response("oops") })),
    ).rejects.toMatchObject({
      service: "sqs",
      code: "InvalidResponse",
      status: 200,
      retryable: false,
    });
  });
  it("retries S3 SlowDown and preserves error response codes when requested", async () => {
    let calls = 0;
    const response = await awsRequest(
      base({
        service: "s3",
        protocol: "s3",
        allowHttpErrors: true,
        fetch: async () =>
          ++calls === 1
            ? new Response("<Error><Code>SlowDown</Code></Error>", {
                status: 503,
              })
            : new Response("<Error><Code>NoSuchKey</Code></Error>", {
                status: 404,
              }),
      }),
    );
    expect(calls).toBe(2);
    expect(response.status).toBe(404);
    expect(response.headers.get("x-amz-error-code")).toBe("NoSuchKey");
  });
});
