import { signAwsRequest } from "@errtraq/aws-signing";
import type {
  BatchHandler,
  CreateContext,
  Delivery,
  Queue,
} from "@errtraq/core";
import { SQS_MAX_BYTES } from "./constants.js";
import type { Config } from "./stack.js";

type Route = { physical: string; producerBinding?: string };
type ConsumerRoute = {
  physical: string;
  topics: readonly string[];
  eventSource: unknown;
};
type Environment = Readonly<Record<string, string | undefined>>;
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const integer = (value: unknown, max: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= max;
const serialize = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (
      item === undefined ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      typeof item === "bigint"
    )
      throw new Error("Message must be JSON serializable");
    return item;
  });

/** Lambda's SQS event fields used by the adapter. */
export interface SqsEvent {
  Records: unknown[];
}
export interface SqsResponse {
  batchItemFailures: { itemIdentifier: string }[];
}
export interface SqsOptions {
  region: string;
  environment: Environment;
  bindings: Record<string, unknown>;
  topics: Record<string, Route>;
  consumers: readonly ConsumerRoute[];
  endpoint?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}
export class SqsQueue implements Queue<SqsEvent, SqsResponse> {
  readonly capabilities = {
    delivery: "push" as const,
    maxBytes: SQS_MAX_BYTES,
    delay: true,
    dlq: true,
  };
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly endpoint: string;
  constructor(private readonly options: SqsOptions) {
    if (!options.region) throw new Error("Missing SQS region");
    const endpoint = new URL(
      options.endpoint ??
        `https://sqs.${options.region}.${options.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`,
    );
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/"
    )
      throw new Error("Invalid SQS endpoint");
    this.endpoint = endpoint.origin;
    this.fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  private async request(
    action: string,
    input: RecordValue,
  ): Promise<RecordValue> {
    const body = JSON.stringify(input);
    for (let attempt = 0; attempt < 4; attempt++) {
      const env = this.options.environment;
      const accessKeyId = env.AWS_ACCESS_KEY_ID,
        secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
      if (!accessKeyId || !secretAccessKey)
        throw new Error("SQS credentials are missing");
      const signed = await signAwsRequest({
        url: `${this.endpoint}/`,
        method: "POST",
        body,
        service: "sqs",
        region: this.options.region,
        accessKeyId,
        secretAccessKey,
        ...(env.AWS_SESSION_TOKEN
          ? { sessionToken: env.AWS_SESSION_TOKEN }
          : {}),
        headers: {
          "content-type": "application/x-amz-json-1.0",
          "x-amz-target": `AmazonSQS.${action}`,
        },
      });
      let response: Response;
      try {
        response = await this.fetcher(signed.url, {
          method: "POST",
          body,
          headers: signed.headers,
          redirect: "manual",
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await this.sleep(50 * 2 ** attempt);
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await response.body?.cancel();
        await this.sleep(50 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`SQS ${action} failed (${response.status})`);
      }
      const result: unknown = await response.json();
      const parsed = object(result);
      if (!parsed) throw new Error(`Invalid SQS ${action} response`);
      return parsed;
    }
    throw new Error(`SQS ${action} retry limit reached`);
  }
  producer: Queue["producer"] = {
    send: async (topic, messages, options) => {
      const route = this.options.topics[topic];
      if (!route?.producerBinding)
        throw new Error(`Unknown or unavailable queue topic: ${topic}`);
      const queueUrl = this.options.bindings[route.producerBinding];
      if (typeof queueUrl !== "string" || !queueUrl)
        throw new Error(`Missing queue binding ${route.producerBinding}`);
      const delay = options?.delaySec ?? 0;
      if (!integer(delay, 900))
        throw new RangeError(
          "SQS delay must be an integer from 0 to 900 seconds",
        );
      const encoder = new TextEncoder();
      const entries = messages.map((message, index) => {
        if (typeof message.key !== "string")
          throw new Error("Message key must be a string");
        const MessageBody = serialize({ topic, message });
        const bytes = encoder.encode(MessageBody).byteLength;
        if (bytes > SQS_MAX_BYTES)
          throw new Error("Message exceeds queue maxBytes");
        return { Id: String(index), MessageBody, DelaySeconds: delay, bytes };
      });
      let batch: typeof entries = [],
        size = 0;
      const flush = async () => {
        if (!batch.length) return;
        let pending = batch;
        for (let attempt = 0; pending.length && attempt < 4; attempt++) {
          const result = await this.request("SendMessageBatch", {
            QueueUrl: queueUrl,
            Entries: pending.map(({ bytes: _bytes, ...entry }) => entry),
          });
          const successes = Array.isArray(result.Successful)
            ? result.Successful
            : [];
          const failures = Array.isArray(result.Failed) ? result.Failed : [];
          const byId = new Map<string, boolean>();
          for (const value of successes) {
            const item = object(value);
            if (typeof item?.Id !== "string" || byId.has(item.Id))
              throw new Error("Invalid SQS batch response");
            byId.set(item.Id, true);
          }
          for (const value of failures) {
            const item = object(value);
            if (typeof item?.Id !== "string" || byId.has(item.Id))
              throw new Error("Invalid SQS batch response");
            if (item.SenderFault === true)
              throw new Error(`SQS batch entry ${item.Id} rejected`);
            byId.set(item.Id, false);
          }
          if (
            byId.size !== pending.length ||
            pending.some((entry) => !byId.has(entry.Id))
          )
            throw new Error("Incomplete SQS batch response");
          pending = pending.filter((entry) => !byId.get(entry.Id));
          if (pending.length && attempt < 3)
            await this.sleep(50 * 2 ** attempt);
        }
        if (pending.length)
          throw new Error("SQS batch entries exhausted retries");
        batch = [];
        size = 0;
      };
      for (const entry of entries) {
        if (batch.length === 10 || size + entry.bytes > SQS_MAX_BYTES)
          await flush();
        batch.push(entry);
        size += entry.bytes;
      }
      await flush();
    },
  };
  private queueUrl(arn: string): string {
    const match = /^arn:([^:]+):sqs:([^:]+):(\d{12}):([^:]+)$/.exec(arn);
    if (!match || match[2] !== this.options.region)
      throw new Error("Invalid SQS event source ARN");
    return `${this.endpoint}/${match[3]}/${encodeURIComponent(match[4] ?? "")}`;
  }
  push = {
    handle: async (
      event: SqsEvent,
      handler: BatchHandler,
    ): Promise<SqsResponse> => {
      if (!event || !Array.isArray(event.Records))
        throw new Error("Invalid SQS event");
      const failed = new Set<string>();
      const deliveries: Delivery[] = [];
      const metadata = new Map<string, { arn: string; receipt: string }>();
      for (const raw of event.Records) {
        const record = object(raw),
          id = record?.messageId;
        if (typeof id !== "string" || !id || metadata.has(id) || failed.has(id))
          throw new Error("Invalid SQS message ID");
        try {
          const arn = record?.eventSourceARN,
            receipt = record?.receiptHandle,
            body = record?.body,
            attrs = object(record?.attributes);
          if (
            typeof arn !== "string" ||
            typeof receipt !== "string" ||
            !receipt ||
            typeof body !== "string"
          )
            throw new Error("Malformed record");
          const route = this.options.consumers.find(
            (item) => item.eventSource === arn,
          );
          if (!route) throw new Error("Unknown queue source");
          const decoded = object(JSON.parse(body));
          const message = object(decoded?.message),
            topic = decoded?.topic;
          const attemptText = attrs?.ApproximateReceiveCount;
          if (
            typeof topic !== "string" ||
            !route.topics.includes(topic) ||
            !message ||
            typeof message.key !== "string" ||
            !Object.hasOwn(message, "body") ||
            typeof attemptText !== "string" ||
            !/^[1-9]\d*$/.test(attemptText) ||
            !Number.isSafeInteger(Number(attemptText))
          )
            throw new Error("Malformed envelope");
          deliveries.push({
            id,
            topic,
            message: { key: message.key, body: message.body },
            attempt: Number(attemptText),
          });
          metadata.set(id, { arn, receipt });
        } catch {
          failed.add(id);
        }
      }
      if (deliveries.length) {
        try {
          const results = await handler(deliveries);
          for (const delivery of deliveries) {
            const matching = results.filter(
              (result) => result.deliveryId === delivery.id,
            );
            const result = matching.length === 1 ? matching[0] : undefined;
            if (result?.action === "ack") continue;
            failed.add(delivery.id);
            if (result?.action === "retry" && result.delaySec !== undefined) {
              if (!integer(result.delaySec, 43200)) continue;
              const meta = metadata.get(delivery.id);
              if (meta)
                try {
                  await this.request("ChangeMessageVisibility", {
                    QueueUrl: this.queueUrl(meta.arn),
                    ReceiptHandle: meta.receipt,
                    VisibilityTimeout: result.delaySec,
                  });
                } catch {
                  /* Failure remains retryable via the original visibility timeout. */
                }
            }
          }
        } catch {
          for (const delivery of deliveries) failed.add(delivery.id);
        }
      }
      return {
        batchItemFailures: [...failed].map((itemIdentifier) => ({
          itemIdentifier,
        })),
      };
    },
  };
}
export function create({
  config,
  bindings,
  topics = {},
  queueConsumers = [],
  environment = {},
}: CreateContext<Config, Record<string, unknown>>): SqsQueue {
  void config; // The stack parser validates config before runtime construction.
  const region = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION;
  if (!region) throw new Error("Missing SQS region (AWS_REGION)");
  return new SqsQueue({
    region,
    environment,
    bindings,
    topics,
    consumers: queueConsumers,
    endpoint: environment.AWS_ENDPOINT_URL_SQS,
  });
}
