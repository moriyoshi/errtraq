import { awsBackoffMs, awsRequest } from "@errtraq/aws-signing";
import type {
  BatchHandler,
  CreateContext,
  Delivery,
  Logger,
  Queue,
} from "@errtraq/core";
import { validateQueueBody } from "@errtraq/core/queue";
import { SQS_MAX_BYTES } from "./constants.js";
import type { Config } from "./stack.js";

type Route = {
  physical: string;
  producerBinding?: string;
  grouping?: "none" | "per-key-serial";
};
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
  JSON.stringify(value)
    .replaceAll("\ufffe", "\\ufffe")
    .replaceAll("\uffff", "\\uffff");

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
  random?: () => number;
  requestTimeoutMs?: number;
  overallTimeoutMs?: number;
  signal?: AbortSignal;
  logger?: Pick<Logger, "warn" | "error">;
}
export class SqsQueue implements Queue<SqsEvent, SqsResponse> {
  readonly capabilities: Queue["capabilities"];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly endpoint: string;
  constructor(private readonly options: SqsOptions) {
    const physicalQueues: Record<
      string,
      { grouping: "per-key-serial" | "none"; delay: boolean }
    > = {};
    for (const route of Object.values(options.topics)) {
      const grouping = route.grouping ?? "none";
      const old = physicalQueues[route.physical];
      if (old && old.grouping !== grouping)
        throw new Error("Conflicting physical queue grouping");
      physicalQueues[route.physical] = { grouping, delay: grouping === "none" };
    }
    for (const route of options.consumers) {
      const grouping =
        typeof route.eventSource === "string" &&
        route.eventSource.endsWith(".fifo")
          ? "per-key-serial"
          : "none";
      const old = physicalQueues[route.physical];
      if (old && old.grouping !== grouping)
        throw new Error("Conflicting physical queue grouping");
      physicalQueues[route.physical] = { grouping, delay: grouping === "none" };
    }
    this.capabilities = {
      delivery: "push",
      maxBytes: SQS_MAX_BYTES,
      delay: true,
      dlq: true,
      grouping: "per-key-serial",
      physicalQueues,
    };
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
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  private async request(
    action: string,
    input: RecordValue,
    overallTimeoutMs = this.options.overallTimeoutMs,
  ): Promise<RecordValue> {
    const response = await awsRequest({
      service: "sqs",
      region: this.options.region,
      url: `${this.endpoint}/`,
      method: "POST",
      body: JSON.stringify(input),
      protocol: "json",
      headers: {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": `AmazonSQS.${action}`,
      },
      credentials: () => ({
        accessKeyId: this.options.environment.AWS_ACCESS_KEY_ID ?? "",
        secretAccessKey: this.options.environment.AWS_SECRET_ACCESS_KEY ?? "",
        sessionToken: this.options.environment.AWS_SESSION_TOKEN,
      }),
      fetch: this.options.fetch,
      sleep: this.options.sleep,
      random: this.options.random,
      requestTimeoutMs: this.options.requestTimeoutMs,
      overallTimeoutMs,
      signal: this.options.signal,
    });
    const parsed: unknown = await response.json();
    const result = object(parsed);
    if (!result) throw new Error(`Invalid SQS ${action} response`);
    return result;
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
      const fifo = route.grouping === "per-key-serial";
      if (fifo && delay !== 0)
        throw new RangeError("FIFO queues do not support per-message delay");
      const encoder = new TextEncoder();
      const entries = messages.map((message, index) => {
        if (typeof message.key !== "string")
          throw new Error("Message key must be a string");
        if (
          fifo &&
          (!message.groupKey ||
            !/^[\x21-\x7e]{1,128}$/.test(message.groupKey) ||
            !/^[\x21-\x7e]{1,128}$/.test(message.key))
        )
          throw new Error(
            "FIFO messages require valid group and deduplication keys",
          );
        validateQueueBody(message.body);
        const MessageBody = serialize({ topic, message });
        const bytes = encoder.encode(MessageBody).byteLength;
        if (bytes > SQS_MAX_BYTES)
          throw new Error("Message exceeds queue maxBytes");
        return {
          Id: String(index),
          MessageBody,
          ...(fifo
            ? {
                MessageGroupId: message.groupKey,
                MessageDeduplicationId: message.key,
              }
            : { DelaySeconds: delay }),
          bytes,
        };
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
            await this.sleep(awsBackoffMs(attempt, this.options.random));
        }
        if (pending.length)
          throw new Error("SQS batch entries exhausted retries");
        batch = [];
        size = 0;
      };
      for (const entry of entries) {
        if (
          batch.length === 10 ||
          size + entry.bytes > SQS_MAX_BYTES ||
          (fifo &&
            "MessageGroupId" in entry &&
            batch.some(
              (item) =>
                "MessageGroupId" in item &&
                item.MessageGroupId === entry.MessageGroupId,
            ))
        )
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
      const deadline = Date.now() + (this.options.overallTimeoutMs ?? 25_000);
      const failed = new Set<string>();
      const deliveries: Delivery[] = [];
      const metadata = new Map<
        string,
        { arn: string; receipt: string; group?: string }
      >();
      const order: string[] = [];
      const fifoEvent = event.Records.some(
        (raw) =>
          typeof object(raw)?.eventSourceARN === "string" &&
          String(object(raw)?.eventSourceARN).endsWith(".fifo"),
      );
      const seen = new Set<string>();
      const logger = this.options.logger ?? {
        warn: (message: string, fields?: Record<string, unknown>) =>
          console.warn(message, fields ?? {}),
        error: (message: string, fields?: Record<string, unknown>) =>
          console.error(message, fields ?? {}),
      };
      for (const raw of event.Records) {
        const record = object(raw),
          id = record?.messageId;
        if (typeof id !== "string" || !id)
          throw new Error("Invalid SQS message ID");
        if (seen.has(id)) continue;
        seen.add(id);
        order.push(id);
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
            throw new Error("malformed record");
          const route = this.options.consumers.find(
            (item) => item.eventSource === arn,
          );
          if (!route) throw new Error("unknown event source");
          let decoded: RecordValue | undefined;
          try {
            decoded = object(JSON.parse(body));
          } catch {
            throw new Error("invalid JSON");
          }
          const message = object(decoded?.message),
            topic = decoded?.topic;
          const attemptText = attrs?.ApproximateReceiveCount;
          if (
            typeof attemptText !== "string" ||
            !/^[1-9]\d*$/.test(attemptText) ||
            !Number.isSafeInteger(Number(attemptText))
          )
            throw new Error("invalid receive count");
          if (
            typeof topic !== "string" ||
            !route.topics.includes(topic) ||
            !message ||
            typeof message.key !== "string" ||
            !Object.hasOwn(message, "body")
          )
            throw new Error("invalid envelope");
          const fifo = arn.endsWith(".fifo");
          const group = attrs?.MessageGroupId;
          if (
            fifo &&
            (typeof group !== "string" || !group || message.groupKey !== group)
          )
            throw new Error("invalid FIFO group");
          deliveries.push({
            id,
            topic,
            message: {
              key: message.key,
              body: message.body,
              ...(typeof message.groupKey === "string"
                ? { groupKey: message.groupKey }
                : {}),
            },
            attempt: Number(attemptText),
          });
          metadata.set(id, {
            arn,
            receipt,
            ...(typeof group === "string" ? { group } : {}),
          });
        } catch (error) {
          failed.add(id);
          const reasons = [
            "malformed record",
            "unknown event source",
            "invalid JSON",
            "invalid receive count",
            "invalid envelope",
            "invalid FIFO group",
          ];
          logger.warn("Invalid SQS record", {
            messageId: id,
            reason:
              error instanceof Error && reasons.includes(error.message)
                ? error.message
                : "malformed record",
          });
        }
      }
      const changes: {
        id: string;
        arn: string;
        receipt: string;
        delay: number;
      }[] = [];
      const apply = async (
        batch: Delivery[],
        ordered: boolean,
      ): Promise<boolean> => {
        let blocked = false;
        try {
          const results = await handler(batch);
          for (const delivery of batch) {
            if (blocked) {
              failed.add(delivery.id);
              continue;
            }
            const matching = results.filter(
              (result) => result.deliveryId === delivery.id,
            );
            const result = matching.length === 1 ? matching[0] : undefined;
            if (result?.action === "ack") continue;
            failed.add(delivery.id);
            if (ordered) blocked = true;
            if (result?.action === "retry" && result.delaySec !== undefined) {
              const delay = result.delaySec;
              if (typeof delay !== "number" || !Number.isFinite(delay)) {
                logger.warn("Invalid SQS retry delay", {
                  messageId: delivery.id,
                  reason: "non-finite delay dropped",
                });
                continue;
              }
              const clamped = Math.min(43200, Math.max(0, Math.floor(delay)));
              if (clamped !== delay)
                logger.warn("Invalid SQS retry delay", {
                  messageId: delivery.id,
                  reason: "delay clamped",
                  delaySec: clamped,
                });
              const meta = metadata.get(delivery.id);
              if (meta)
                changes.push({ id: delivery.id, ...meta, delay: clamped });
            }
          }
        } catch {
          for (const delivery of batch) failed.add(delivery.id);
          return true;
        }
        return blocked;
      };
      if (!fifoEvent) {
        if (deliveries.length) await apply(deliveries, false);
      } else {
        const byId = new Map(
          deliveries.map((delivery) => [delivery.id, delivery]),
        );
        let blocked = false;
        for (let index = 0; index < order.length; ) {
          const id = order[index];
          if (!id) {
            index++;
            continue;
          }
          if (blocked || failed.has(id)) {
            failed.add(id);
            blocked = true;
            index++;
            continue;
          }
          const first = byId.get(id);
          if (!first) {
            failed.add(id);
            blocked = true;
            index++;
            continue;
          }
          const group = metadata.get(id)?.group;
          const batch: Delivery[] = [];
          while (index < order.length) {
            const nextId = order[index];
            if (
              !nextId ||
              failed.has(nextId) ||
              metadata.get(nextId)?.group !== group
            )
              break;
            const next = byId.get(nextId);
            if (!next) break;
            batch.push(next);
            index++;
          }
          blocked = await apply(batch, true);
        }
      }
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, changes.length) }, async () => {
          for (;;) {
            const change = changes[index++];
            if (!change) return;
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              logger.error("SQS visibility change failed", {
                messageId: change.id,
                reason: "deadline exceeded",
              });
              continue;
            }
            try {
              await this.request(
                "ChangeMessageVisibility",
                {
                  QueueUrl: this.queueUrl(change.arn),
                  ReceiptHandle: change.receipt,
                  VisibilityTimeout: change.delay,
                },
                remaining,
              );
            } catch {
              logger.error("SQS visibility change failed", {
                messageId: change.id,
                reason: "request failed",
              });
            }
          }
        }),
      );
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
  logger,
}: CreateContext<Config, Record<string, unknown>>): SqsQueue {
  const region = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION;
  if (!region) throw new Error("Missing SQS region (AWS_REGION)");
  return new SqsQueue({
    region,
    environment,
    bindings,
    topics,
    consumers: queueConsumers,
    endpoint: environment.AWS_ENDPOINT_URL_SQS,
    requestTimeoutMs: config.requestTimeoutMs,
    overallTimeoutMs: config.overallTimeoutMs,
    logger,
  });
}
