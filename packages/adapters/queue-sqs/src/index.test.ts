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
const record = (id: string, changes: Record<string, unknown> = {}) => ({
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
  it("acknowledges successes, changes visibility for delayed retries, and reports malformed and unknown sources", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      response({}),
    );
    const event: SqsEvent = {
      Records: [
        record("ok"),
        record("retry"),
        record("bad", { body: "{" }),
        record("wrong", { eventSourceARN: `${arn}x` }),
        record("wrong-topic", {
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
    const event = { Records: [record("a"), record("b")] };
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
        await queue.push.handle({ Records: [record("a")] }, async () => [
          { deliveryId: "a", action: "retry", delaySec: 10 },
        ])
      ).batchItemFailures,
    ).toEqual([{ itemIdentifier: "a" }]);
  });
});
