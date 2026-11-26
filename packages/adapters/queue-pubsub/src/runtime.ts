import type {
  BatchHandler,
  CreateContext,
  Delivery,
  Logger,
  Queue,
} from "@moriyoshi/errtraq-core";
import { validateQueueBody } from "@moriyoshi/errtraq-core/queue";
import {
  KEY_ATTRIBUTE,
  PUBSUB_ENTRY_OVERHEAD_BYTES,
  PUBSUB_MAX_ATTRIBUTE_VALUE_BYTES,
  PUBSUB_MAX_BYTES,
  PUBSUB_MAX_ORDERING_KEY_BYTES,
  PUBSUB_MAX_REQUEST_BYTES,
  PUBSUB_MAX_REQUEST_MESSAGES,
  TOPIC_ATTRIBUTE,
} from "./constants.js";
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
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;

/** The HTTP request Pub/Sub sends to a push endpoint, as the platform hands it over. */
export interface PubsubPushRequest {
  method: string;
  headers: Headers | Readonly<Record<string, string | undefined>>;
  /** Raw JSON text, or the already parsed JSON value. */
  body: unknown;
}
/**
 * Every status other than 102, 200, 201, 202 and 204 is a nack
 * (https://docs.cloud.google.com/pubsub/docs/push, fetched 2026-11-26).
 */
export interface PubsubPushResponse {
  status: number;
}
/** Pub/Sub acknowledges 102, 200, 201, 202 and 204; this adapter uses 204. */
export const PUSH_ACK = 204;
/** Handler asked for a retry (or returned no result for the delivery). */
export const PUSH_RETRY = 503;
/** Handler threw. */
export const PUSH_ERROR = 500;
/** Malformed body, unknown subscription or topic; retried into the DLQ, never dropped. */
export const PUSH_INVALID = 400;
export const PUSH_UNAUTHENTICATED = 401;
export const PUSH_METHOD_NOT_ALLOWED = 405;

export interface PubsubOptions {
  projectId: string;
  region: string;
  topics: Record<string, Route>;
  consumers: readonly ConsumerRoute[];
  bindings: Record<string, unknown>;
  /** Emulator or test endpoint; replaces both the global and the regional host. */
  endpoint?: string;
  /** OAuth access token source for publishing; the Cloud Run platform wires gcp-auth here. */
  accessToken?: () => Promise<string>;
  /** Push request authentication; the Cloud Run platform wires the gcp-auth ID token verifier here. */
  verifyPush?: (request: PubsubPushRequest) => Promise<boolean>;
  /** Accept pushes without verification. Tests and emulators only. */
  allowUnauthenticatedPush?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  requestTimeoutMs?: number;
  overallTimeoutMs?: number;
  signal?: AbortSignal;
  logger?: Pick<Logger, "warn" | "error">;
}

const encoder = new TextEncoder();
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) throw new Error("bad base64");
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(key));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
/** Keys within the ordering key limit are used as is; longer keys are hashed. */
export async function orderingKeyFor(groupKey: string): Promise<string> {
  return encoder.encode(groupKey).byteLength <= PUBSUB_MAX_ORDERING_KEY_BYTES
    ? groupKey
    : hashKey(groupKey);
}
class PermanentPublishError extends Error {}
const TOPIC_RESOURCE = /^projects\/[^/]+\/topics\/[^/]+$/;
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);
const backoffMs = (attempt: number, random: () => number) =>
  Math.min(10_000, 100 * 2 ** attempt) * (0.5 + random() / 2);

type Entry = {
  data: string;
  attributes: Record<string, string>;
  orderingKey?: string;
  bytes: number;
};

export class PubsubQueue
  implements Queue<PubsubPushRequest, PubsubPushResponse>
{
  readonly capabilities: Queue["capabilities"];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly fetcher: typeof fetch;
  private readonly logger: Pick<Logger, "warn" | "error">;
  private readonly groupedPhysical = new Set<string>();
  constructor(private readonly options: PubsubOptions) {
    if (!options.projectId) throw new Error("Missing Pub/Sub project id");
    if (!options.region) throw new Error("Missing Pub/Sub region");
    const physicalQueues: Record<
      string,
      { grouping: "per-key-serial" | "none"; delay: boolean }
    > = {};
    for (const route of Object.values(options.topics)) {
      const grouping = route.grouping ?? "none";
      const old = physicalQueues[route.physical];
      if (old && old.grouping !== grouping)
        throw new Error("Conflicting physical queue grouping");
      physicalQueues[route.physical] = { grouping, delay: false };
      if (grouping === "per-key-serial")
        this.groupedPhysical.add(route.physical);
    }
    for (const route of options.consumers)
      physicalQueues[route.physical] ??= { grouping: "none", delay: false };
    this.capabilities = {
      delivery: "push",
      maxBytes: PUBSUB_MAX_BYTES,
      delay: false,
      dlq: true,
      grouping: "per-key-serial",
      physicalQueues,
    };
    if (
      options.consumers.length > 0 &&
      !options.verifyPush &&
      !options.allowUnauthenticatedPush
    )
      throw new Error(
        "Pub/Sub push consumers need verifyPush, or allowUnauthenticatedPush (tests and emulators only, or platform-side authentication)",
      );
    if (options.endpoint) {
      const url = new URL(options.endpoint);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error("Invalid Pub/Sub endpoint");
    } else if (!options.accessToken)
      throw new Error("Pub/Sub publishing needs an accessToken source");
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
    this.logger = options.logger ?? {
      warn: (message, fields) => console.warn(message, fields ?? {}),
      error: (message, fields) => console.error(message, fields ?? {}),
    };
  }
  private base(ordered: boolean): string {
    if (this.options.endpoint) return new URL(this.options.endpoint).origin;
    // Ordered publishes must go to one region (GCP_PLAN 4.2).
    return ordered
      ? `https://${this.options.region}-pubsub.googleapis.com`
      : "https://pubsub.googleapis.com";
  }
  private async publishRequest(
    topic: string,
    entries: Entry[],
    ordered: boolean,
  ): Promise<void> {
    const url = `${this.base(ordered)}/v1/${topic}:publish`;
    const body = JSON.stringify({
      messages: entries.map(({ bytes: _bytes, ...message }) => message),
    });
    const deadline = Date.now() + (this.options.overallTimeoutMs ?? 30_000);
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await this.sleep(backoffMs(attempt - 1, this.random));
        if (Date.now() > deadline) break;
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(
          1,
          Math.min(
            this.options.requestTimeoutMs ?? 10_000,
            deadline - Date.now(),
          ),
        ),
      );
      const onAbort = () => controller.abort();
      this.options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (this.options.accessToken)
          headers.authorization = `Bearer ${await this.options.accessToken()}`;
        const response = await this.fetcher(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (response.ok) {
          const parsed = object(await response.json());
          const ids = parsed?.messageIds;
          if (!Array.isArray(ids) || ids.length !== entries.length)
            throw new PermanentPublishError("Invalid Pub/Sub publish response");
          return;
        }
        const detail = await response.text().catch(() => "");
        let status = "";
        try {
          const error = object(object(JSON.parse(detail))?.error);
          status = String(error?.status ?? "");
        } catch {
          // The body is not JSON; the HTTP status alone is reported.
        }
        const message = `Pub/Sub publish failed: HTTP ${response.status}${status ? ` ${status}` : ""}`;
        if (!TRANSIENT.has(response.status))
          throw new PermanentPublishError(message);
        lastError = new Error(message);
      } catch (error) {
        if (
          error instanceof PermanentPublishError ||
          this.options.signal?.aborted
        )
          throw error;
        // Network errors and timeouts are transient.
        lastError = error;
      } finally {
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Pub/Sub publish failed");
  }

  producer: Queue["producer"] = {
    send: async (topic, messages, options) => {
      const route = this.options.topics[topic];
      if (!route?.producerBinding)
        throw new Error(`Unknown or unavailable queue topic: ${topic}`);
      const resource = this.options.bindings[route.producerBinding];
      if (typeof resource !== "string" || !TOPIC_RESOURCE.test(resource))
        throw new Error(`Missing queue binding ${route.producerBinding}`);
      const delay = options?.delaySec ?? 0;
      if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0)
        throw new RangeError("delaySec must be finite and non-negative");
      if (delay > 0)
        throw new RangeError("Pub/Sub does not support per-message delay");
      const grouped = route.grouping === "per-key-serial";
      const entries: Entry[] = [];
      for (const message of messages) {
        if (typeof message.key !== "string" || !message.key)
          throw new Error("Message key must be a non-empty string");
        if (
          grouped &&
          (!message.groupKey || typeof message.groupKey !== "string")
        )
          throw new Error("Grouped messages require a group key");
        validateQueueBody(message.body);
        const data = encoder.encode(
          JSON.stringify({
            key: message.key,
            body: message.body,
            ...(message.groupKey === undefined
              ? {}
              : { groupKey: message.groupKey }),
          }),
        );
        if (data.byteLength > PUBSUB_MAX_BYTES)
          throw new Error("Message exceeds queue maxBytes");
        const attributes: Record<string, string> = { [TOPIC_ATTRIBUTE]: topic };
        if (
          encoder.encode(message.key).byteLength <=
          PUBSUB_MAX_ATTRIBUTE_VALUE_BYTES
        )
          attributes[KEY_ATTRIBUTE] = message.key;
        const encoded = toBase64(data);
        entries.push({
          data: encoded,
          attributes,
          ...(grouped && message.groupKey
            ? { orderingKey: await orderingKeyFor(message.groupKey) }
            : {}),
          bytes: encoded.length + PUBSUB_ENTRY_OVERHEAD_BYTES,
        });
      }
      let batch: Entry[] = [];
      let size = 0;
      // Sequential and in order: a failure stops the send, so no later message
      // of an ordering key overtakes an earlier one that did not publish.
      const flush = async () => {
        if (!batch.length) return;
        await this.publishRequest(resource, batch, grouped);
        batch = [];
        size = 0;
      };
      for (const entry of entries) {
        if (
          batch.length === PUBSUB_MAX_REQUEST_MESSAGES ||
          size + entry.bytes >
            PUBSUB_MAX_REQUEST_BYTES - PUBSUB_ENTRY_OVERHEAD_BYTES
        )
          await flush();
        batch.push(entry);
        size += entry.bytes;
      }
      await flush();
    },
  };

  private async decode(request: PubsubPushRequest): Promise<Delivery> {
    let body: unknown = request.body;
    if (typeof body === "string") body = JSON.parse(body);
    const envelope = object(body);
    const message = object(envelope?.message);
    const subscription = envelope?.subscription;
    if (
      !message ||
      typeof subscription !== "string" ||
      typeof message.data !== "string" ||
      typeof message.messageId !== "string" ||
      !message.messageId
    )
      throw new Error("malformed envelope");
    const route = this.options.consumers.find(
      (item) => item.eventSource === subscription,
    );
    if (!route) throw new Error("unknown subscription");
    const attributes = object(message.attributes);
    const topic = attributes?.[TOPIC_ATTRIBUTE];
    if (typeof topic !== "string" || !route.topics.includes(topic))
      throw new Error("unknown topic");
    let decoded: RecordValue | undefined;
    try {
      decoded = object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            fromBase64(message.data),
          ),
        ),
      );
    } catch {
      throw new Error("invalid data");
    }
    if (typeof decoded?.key !== "string" || !Object.hasOwn(decoded, "body"))
      throw new Error("invalid data");
    const groupKey = decoded.groupKey;
    if (groupKey !== undefined && typeof groupKey !== "string")
      throw new Error("invalid data");
    if (this.groupedPhysical.has(route.physical)) {
      // The data is authoritative for the group key. orderingKey is a
      // consistency check, and absent on the Pub/Sub emulator's push body.
      if (
        !groupKey ||
        (message.orderingKey !== undefined &&
          message.orderingKey !== (await orderingKeyFor(groupKey)))
      )
        throw new Error("invalid ordering key");
    }
    // deliveryAttempt is present only when the subscription has a dead-letter policy.
    const attemptValue = envelope?.deliveryAttempt;
    if (
      attemptValue !== undefined &&
      !(Number.isSafeInteger(attemptValue) && (attemptValue as number) >= 1)
    )
      throw new Error("invalid delivery attempt");
    return {
      id: message.messageId,
      topic,
      message: {
        key: decoded.key,
        body: decoded.body,
        ...(groupKey === undefined ? {} : { groupKey }),
      },
      attempt: (attemptValue as number | undefined) ?? 1,
    };
  }

  push = {
    handle: async (
      request: PubsubPushRequest,
      handler: BatchHandler,
    ): Promise<PubsubPushResponse> => {
      if (request.method.toUpperCase() !== "POST")
        return { status: PUSH_METHOD_NOT_ALLOWED };
      if (this.options.verifyPush) {
        let allowed = false;
        try {
          allowed = (await this.options.verifyPush(request)) === true;
        } catch {
          this.logger.error("Pub/Sub push verification failed", {
            reason: "verifier error",
          });
          return { status: PUSH_RETRY };
        }
        if (!allowed) return { status: PUSH_UNAUTHENTICATED };
      } else if (!this.options.allowUnauthenticatedPush)
        return { status: PUSH_UNAUTHENTICATED };
      let delivery: Delivery;
      try {
        delivery = await this.decode(request);
      } catch (error) {
        const reasons = [
          "malformed envelope",
          "unknown subscription",
          "unknown topic",
          "invalid data",
          "invalid ordering key",
          "invalid delivery attempt",
        ];
        this.logger.warn("Invalid Pub/Sub push", {
          reason:
            error instanceof Error && reasons.includes(error.message)
              ? error.message
              : "malformed envelope",
        });
        return { status: PUSH_INVALID };
      }
      try {
        const results = await handler([delivery]);
        const matching = results.filter(
          (result) => result.deliveryId === delivery.id,
        );
        const result = matching.length === 1 ? matching[0] : undefined;
        if (result?.action === "ack") return { status: PUSH_ACK };
        if (result?.action === "retry" && result.delaySec !== undefined)
          this.logger.warn("Pub/Sub cannot honour retry delay", {
            messageId: delivery.id,
            reason: "subscription retry policy decides",
          });
        return { status: PUSH_RETRY };
      } catch {
        return { status: PUSH_ERROR };
      }
    },
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/**
 * `pushAuth: "none"` is a test switch that must be impossible to enable in a deployment: it
 * needs a loopback Pub/Sub endpoint (a deployed function cannot publish to one) and is refused
 * outright when the host is Cloud Run (`K_SERVICE` is set by the platform and reserved).
 */
export function assertEmulatorOnlyPushAuth(
  endpoint: string | undefined,
  emulatorHost: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (environment.K_SERVICE || environment.K_REVISION)
    throw new Error("pushAuth none is not allowed on Cloud Run");
  const origin = endpoint ?? (emulatorHost ? `http://${emulatorHost}` : "");
  let hostname = "";
  try {
    hostname = new URL(origin).hostname;
  } catch {
    /* rejected below */
  }
  if (!LOOPBACK_HOSTS.has(hostname))
    throw new Error("pushAuth none requires a loopback Pub/Sub emulator");
}

export function create({
  config,
  bindings,
  dependencies,
  topics = {},
  queueConsumers = [],
  environment = {},
  logger,
}: CreateContext<Config, Record<string, unknown>>): PubsubQueue {
  const emulator = environment.PUBSUB_EMULATOR_HOST;
  // The Cloud Run platform injects `accessToken` and `verifyPush` (gcp-auth) as host bindings.
  const accessToken = bindings.accessToken ?? dependencies?.accessToken;
  const verifyPush = bindings.verifyPush ?? dependencies?.verifyPush;
  const pushAuth = config.pushAuth ?? "verifier";
  if (pushAuth === "none") {
    assertEmulatorOnlyPushAuth(config.endpoint, emulator, environment);
    logger?.warn("Pub/Sub push authentication disabled", {
      reason: "pushAuth none is for tests and emulators only",
    });
  }
  return new PubsubQueue({
    projectId: config.projectId,
    region: config.region,
    bindings,
    topics,
    consumers: queueConsumers,
    endpoint: config.endpoint ?? (emulator ? `http://${emulator}` : undefined),
    accessToken:
      typeof accessToken === "function"
        ? (accessToken as () => Promise<string>)
        : undefined,
    // `platform` and `none` mean the push is not verified here, whatever the host injects.
    verifyPush:
      pushAuth === "verifier" && typeof verifyPush === "function"
        ? (verifyPush as PubsubOptions["verifyPush"])
        : undefined,
    allowUnauthenticatedPush: pushAuth === "none" || pushAuth === "platform",
    requestTimeoutMs: config.requestTimeoutMs,
    overallTimeoutMs: config.overallTimeoutMs,
    logger,
  });
}
