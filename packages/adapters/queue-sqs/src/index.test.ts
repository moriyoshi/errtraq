import type { Delivery } from "@errtraq/core";
import { describe, expect, it, vi } from "vitest";
import { type SqsEvent, SqsQueue } from "./runtime.js";

const arn = "arn:aws:sqs:us-east-1:123456789012:messages";
const env = {
  AWS_ACCESS_KEY_ID: "test",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_SESSION_TOKEN: "session",
};
const make = (fetcher: typeof fetch) =>
  new SqsQueue({
    region: "us-east-1",
    environment: env,
    bindings: {
      URL: "https://sqs.us-east-1.amazonaws.com/123456789012/messages",
    },
    topics: { ingest: { physical: "shared", producerBinding: "URL" } },
    consumers: [{ physical: "shared", topics: ["ingest"], eventSource: arn }],
    fetch: fetcher,
    sleep: async () => {},
  });
// Based on the AWS Lambda standard SQS event example; the body and IDs are test fixtures.
// https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#example-standard-queue-message-event
const documentedExampleRecord = (
  id: string,
  changes: Record<string, unknown> = {},
) => ({
  messageId: id,
  receiptHandle: `receipt-${id}`,
  body: JSON.stringify({
    topic: "ingest",
    message: { key: id, body: { value: 1 } },
  }),
  attributes: {
    ApproximateReceiveCount: "3",
    SentTimestamp: "1600000000000",
    SenderId: "fixture",
    ApproximateFirstReceiveTimestamp: "1600000000001",
  },
  messageAttributes: {},
  md5OfBody: "deadbeef",
  eventSource: "aws:sqs",
  eventSourceARN: arn,
  awsRegion: "us-east-1",
  ...changes,
});
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/x-amz-json-1.0" },
  });

describe("SQS producer", () => {
  it("escapes SQS-forbidden Unicode noncharacters in the wire body", async () => {
    let wire = "";
    const queue = make(async (_url, init) => {
      wire = JSON.parse(String(init?.body)).Entries[0].MessageBody;
      return response({ Successful: [{ Id: "0" }] });
    });
    await queue.producer.send("ingest", [{ key: "k", body: "x\ufffe\uffff" }]);
    expect(wire).toContain("\\ufffe\\uffff");
    expect(JSON.parse(wire).message.body).toBe("x\ufffe\uffff");
  });
  it("uses full jitter for retryable per-entry failures", async () => {
    const waits: number[] = [];
    let calls = 0;
    const q = new SqsQueue({
      region: "us-east-1",
      environment: env,
      bindings: { URL: "https://example.test/queue" },
      topics: { ingest: { physical: "shared", producerBinding: "URL" } },
      consumers: [],
      random: () => 0.5,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async () =>
        ++calls === 1
          ? response({ Failed: [{ Id: "0", SenderFault: false }] })
          : response({ Successful: [{ Id: "0" }] }),
    });
    await q.producer.send("ingest", [{ key: "a", body: 1 }]);
    expect(waits).toEqual([250]);
  });
  it("retries HTTP 400 throttling and exposes typed malformed-response errors", async () => {
    let calls = 0;
    const q = make(async () =>
      ++calls === 1
        ? new Response(JSON.stringify({ __type: "com.aws#RequestThrottled" }), {
            status: 400,
          })
        : response({ Successful: [{ Id: "0" }] }),
    );
    await q.producer.send("ingest", [{ key: "a", body: 1 }]);
    expect(calls).toBe(2);
    await expect(
      make(async () => new Response("not json")).producer.send("ingest", [
        { key: "a", body: 1 },
      ]),
    ).rejects.toMatchObject({
      name: "AwsRequestError",
      service: "sqs",
      code: "InvalidResponse",
    });
  });
  it("splits batches at the byte limit and carries the topic and delay", async () => {
    const batches: {
      MessageBody: string;
      DelaySeconds: number;
      Id: string;
    }[][] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      batches.push(payload.Entries);
      return response({
        Successful: payload.Entries.map((entry: { Id: string }) => ({
          Id: entry.Id,
        })),
      });
    });
    await make(fetcher).producer.send(
      "ingest",
      [
        { key: "a", body: "x".repeat(600_000) },
        { key: "b", body: "x".repeat(600_000) },
      ],
      { delaySec: 9 },
    );
    expect(batches.map((batch) => batch.length)).toEqual([1, 1]);
    expect(batches[0]?.[0]?.DelaySeconds).toBe(9);
    expect(JSON.parse(batches[0]?.[0]?.MessageBody ?? "").topic).toBe("ingest");
  });
  it("batches up to ten entries and retries only transient per-entry failures", async () => {
    const batches: string[][] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      const ids = payload.Entries.map(
        (entry: { Id: string }) => entry.Id,
      ) as string[];
      batches.push(ids);
      expect(new Headers(init?.headers).get("x-amz-security-token")).toBe(
        "session",
      );
      if (batches.length === 1)
        return response({
          Successful: ids.slice(1).map((Id) => ({ Id })),
          Failed: [{ Id: ids[0], SenderFault: false }],
        });
      return response({ Successful: ids.map((Id) => ({ Id })) });
    });
    await make(fetcher).producer.send(
      "ingest",
      Array.from({ length: 12 }, (_, i) => ({ key: String(i), body: i })),
      { delaySec: 3 },
    );
    expect(batches.map((x) => x.length)).toEqual([10, 1, 2]);
    expect(batches[1]).toEqual(["0"]);
  });
  it("rejects invalid or oversized whole batches before sending", async () => {
    const fetcher = vi.fn();
    const queue = make(fetcher);
    await expect(
      queue.producer.send("ingest", [
        { key: "a", body: 1 },
        { key: "b", body: () => {} },
      ]),
    ).rejects.toThrow();
    await expect(
      queue.producer.send("ingest", [
        { key: "a", body: "x".repeat(queue.capabilities.maxBytes) },
      ]),
    ).rejects.toThrow();
    await expect(
      queue.producer.send("ingest", [{ key: "a", body: 1 }], { delaySec: 901 }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects sender errors and exhausted transient failures", async () => {
    const sender = vi.fn(async () =>
      response({ Failed: [{ Id: "0", SenderFault: true }] }),
    );
    await expect(
      make(sender).producer.send("ingest", [{ key: "a", body: 1 }]),
    ).rejects.toThrow("rejected");
    const transient = vi.fn(async () =>
      response({ Failed: [{ Id: "0", SenderFault: false }] }),
    );
    await expect(
      make(transient).producer.send("ingest", [{ key: "a", body: 1 }]),
    ).rejects.toThrow("exhausted");
    expect(transient).toHaveBeenCalledTimes(4);
  });
});
describe("Lambda SQS events", () => {
  it("logs dropped delays and failed visibility changes without sensitive data", async () => {
    const logs: unknown[] = [];
    const q = new SqsQueue({
      region: "us-east-1",
      environment: env,
      bindings: {},
      topics: {},
      consumers: [{ physical: "shared", topics: ["ingest"], eventSource: arn }],
      logger: {
        warn: (m, f) => logs.push([m, f]),
        error: (m, f) => logs.push([m, f]),
      },
      fetch: async () => new Response("secret-response", { status: 403 }),
    });
    const result = await q.push.handle(
      {
        Records: [
          documentedExampleRecord("bad-delay"),
          documentedExampleRecord("failed"),
        ],
      },
      async () => [
        { deliveryId: "bad-delay", action: "retry", delaySec: NaN },
        { deliveryId: "failed", action: "retry", delaySec: 1 },
      ],
    );
    expect(result.batchItemFailures).toHaveLength(2);
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain("secret-response");
    expect(JSON.stringify(logs)).not.toContain("receipt-");
  });
  it("bounds visibility concurrency and invocation deadline while preserving acknowledgements", async () => {
    let active = 0,
      peak = 0;
    const warns: unknown[] = [];
    const q = new SqsQueue({
      region: "us-east-1",
      environment: env,
      bindings: {},
      topics: {},
      consumers: [{ physical: "shared", topics: ["ingest"], eventSource: arn }],
      overallTimeoutMs: 1000,
      logger: {
        warn: (m, f) => warns.push([m, f]),
        error: (m, f) => warns.push([m, f]),
      },
      fetch: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active--;
        return response({});
      },
    });
    const result = await q.push.handle(
      {
        Records: Array.from({ length: 10 }, (_, i) =>
          documentedExampleRecord(String(i)),
        ),
      },
      async (batch) =>
        batch.map((d) => ({
          deliveryId: d.id,
          action: "retry" as const,
          delaySec: 1,
        })),
    );
    expect(result.batchItemFailures).toHaveLength(10);
    expect(peak).toBe(4);
    expect(warns).toEqual([]);
    const hung = new SqsQueue({
      region: "us-east-1",
      environment: env,
      bindings: {},
      topics: {},
      consumers: [{ physical: "shared", topics: ["ingest"], eventSource: arn }],
      overallTimeoutMs: 40,
      logger: { warn: () => {}, error: (m, f) => warns.push([m, f]) },
      fetch: async () => await new Promise<Response>(() => {}),
    });
    const output = await hung.push.handle(
      {
        Records: [
          documentedExampleRecord("ok"),
          documentedExampleRecord("bad"),
        ],
      },
      async () => [
        { deliveryId: "ok", action: "ack" },
        { deliveryId: "bad", action: "retry", delaySec: 1 },
      ],
    );
    expect(output.batchItemFailures).toEqual([{ itemIdentifier: "bad" }]);
    expect(warns).toHaveLength(1);
  });
  it("logs poison and clamped delays without data, and deduplicates message IDs", async () => {
    const logs: unknown[] = [];
    const requests: Record<string, unknown>[] = [];
    const q = new SqsQueue({
      region: "us-east-1",
      environment: env,
      bindings: {},
      topics: {},
      consumers: [{ physical: "shared", topics: ["ingest"], eventSource: arn }],
      logger: {
        warn: (m, f) => logs.push([m, f]),
        error: (m, f) => logs.push([m, f]),
      },
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return response({});
      },
    });
    const handler = vi.fn(async (_batch: Delivery[]) => [
      { deliveryId: "one", action: "retry" as const, delaySec: 43201.2 },
    ]);
    const result = await q.push.handle(
      {
        Records: [
          documentedExampleRecord("one"),
          documentedExampleRecord("one"),
          documentedExampleRecord("poison", { body: "secret-body{" }),
          documentedExampleRecord("poison", { body: "secret-body{" }),
          documentedExampleRecord("count", {
            attributes: { ApproximateReceiveCount: "invalid" },
          }),
          documentedExampleRecord("missing-count", { attributes: {} }),
          documentedExampleRecord("unknown", { eventSourceARN: `${arn}x` }),
        ],
      },
      handler,
    );
    expect(handler.mock.calls[0]?.[0]).toHaveLength(1);
    expect(
      result.batchItemFailures.map((x) => x.itemIdentifier).sort(),
    ).toEqual(["count", "missing-count", "one", "poison", "unknown"]);
    expect(requests[0]?.VisibilityTimeout).toBe(43200);
    expect(logs).toHaveLength(5);
    expect(JSON.stringify(logs)).not.toContain("secret-body");
    expect(JSON.stringify(logs)).not.toContain("receipt-");
  });
  it("acknowledges successes, changes visibility for delayed retries, and reports malformed and unknown sources", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      response({}),
    );
    const event: SqsEvent = {
      Records: [
        documentedExampleRecord("ok"),
        documentedExampleRecord("retry"),
        documentedExampleRecord("bad", { body: "{" }),
        documentedExampleRecord("wrong", { eventSourceARN: `${arn}x` }),
        documentedExampleRecord("wrong-topic", {
          body: JSON.stringify({
            topic: "archive.project",
            message: { key: "x", body: 1 },
          }),
        }),
      ],
    };
    const handler = vi.fn(async (deliveries) =>
      deliveries.map((d: { id: string }) =>
        d.id === "ok"
          ? { deliveryId: d.id, action: "ack" as const }
          : { deliveryId: d.id, action: "retry" as const, delaySec: 7 },
      ),
    );
    const result = await make(fetcher).push.handle(event, handler);
    expect(handler.mock.calls[0]?.[0][0]).toMatchObject({
      id: "ok",
      topic: "ingest",
      attempt: 3,
      message: { key: "ok", body: { value: 1 } },
    });
    expect(
      result.batchItemFailures.map((x) => x.itemIdentifier).sort(),
    ).toEqual(["bad", "retry", "wrong", "wrong-topic"]);
    const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(request).toEqual({
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/messages",
      ReceiptHandle: "receipt-retry",
      VisibilityTimeout: 7,
    });
  });
  it("retries all valid records when the handler throws or omits an outcome", async () => {
    const queue = make(vi.fn());
    const event = {
      Records: [documentedExampleRecord("a"), documentedExampleRecord("b")],
    };
    expect(
      (
        await queue.push.handle(event, async () => {
          throw new Error("oops");
        })
      ).batchItemFailures,
    ).toHaveLength(2);
    expect(
      (await queue.push.handle(event, async () => [])).batchItemFailures,
    ).toHaveLength(2);
  });
  it("preserves a retry if visibility update fails", async () => {
    const queue = make(vi.fn(async () => new Response(null, { status: 403 })));
    expect(
      (
        await queue.push.handle(
          { Records: [documentedExampleRecord("a")] },
          async () => [{ deliveryId: "a", action: "retry", delaySec: 10 }],
        )
      ).batchItemFailures,
    ).toEqual([{ itemIdentifier: "a" }]);
  });
});
