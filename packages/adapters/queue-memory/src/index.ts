import {
  type Clock,
  type CreateContext,
  type Delivery,
  type Logger,
  type Queue,
  toTimestamp,
  validateQueueBody,
} from "@moriyoshi/errtraq-core";
import { configSchema, QUEUE_MAX_BYTES, type QueueConfig } from "./stack.js";

export { infra, manifest } from "./stack.js";

interface Pending {
  delivery: Delivery;
  available: number;
  retryAfterReal?: number;
}
export class MemoryQueue implements Queue {
  readonly capabilities: Queue["capabilities"];
  private readonly pending: Pending[] = [];
  private readonly running = new Map<string, Delivery>();
  private nextId = 0;
  private readonly waiters = new Set<() => void>();
  private readonly clock: Clock;
  private readonly systemClock: boolean;
  private readonly maxAttempts: number;
  private readonly logger: Pick<Logger, "error">;
  private readonly topicMap:
    | Record<string, { physical: string; grouping?: "none" | "per-key-serial" }>
    | undefined;
  private group(delivery: Delivery): string | undefined {
    return delivery.message.groupKey
      ? JSON.stringify([
          this.topicMap?.[delivery.topic]?.physical ?? "shared",
          delivery.message.groupKey,
        ])
      : undefined;
  }
  constructor(
    config: QueueConfig = {},
    clock?: Clock,
    logger: Pick<Logger, "error"> = {
      error: (message, fields) => console.error(message, fields),
    },
    topics?: Record<
      string,
      { physical: string; grouping?: "none" | "per-key-serial" }
    >,
  ) {
    this.topicMap = topics && Object.keys(topics).length ? topics : undefined;
    this.systemClock = clock === undefined;
    this.clock = clock ?? { now: () => toTimestamp(new Date()) };
    this.maxAttempts = configSchema.parse(config).maxAttempts;
    this.logger = logger;
    this.capabilities = {
      delivery: "pull",
      delay: true,
      dlq: false,
      grouping: "per-key-serial",
      maxBytes: QUEUE_MAX_BYTES,
    };
  }
  /** Snapshot of messages currently being handled, for local observability. */
  get inFlight(): readonly Delivery[] {
    return structuredClone([...this.running.values()]);
  }
  async idle(): Promise<boolean> {
    return this.pending.length === 0 && this.running.size === 0;
  }
  producer: Queue["producer"] = {
    send: async (topic, messages, options) => {
      if (this.topicMap && !Object.hasOwn(this.topicMap, topic))
        throw new Error(`Unknown queue topic: ${topic}`);
      const delay = options?.delaySec ?? 0;
      if (!Number.isFinite(delay) || delay < 0)
        throw new RangeError("Invalid queue delay");
      for (const message of messages) {
        validateQueueBody(message.body);
        if (
          this.topicMap?.[topic]?.grouping === "per-key-serial" &&
          !message.groupKey
        )
          throw new TypeError("Grouped topic requires a group key");
        if (
          message.groupKey !== undefined &&
          (typeof message.groupKey !== "string" || !message.groupKey)
        )
          throw new TypeError("Invalid group key");
      }
      const copied = messages.map((message) => structuredClone(message));
      for (const message of copied) {
        const json = JSON.stringify(message);
        if (
          json === undefined ||
          new TextEncoder().encode(json).byteLength > this.capabilities.maxBytes
        )
          throw new Error("Message exceeds queue maxBytes");
      }
      const available = Date.parse(this.clock.now()) + delay * 1000;
      for (const message of copied)
        this.pending.push({
          delivery: { id: String(++this.nextId), topic, message, attempt: 1 },
          available,
        });
      for (const wake of [...this.waiters]) wake();
    },
  };
  pull: NonNullable<Queue["pull"]> = {
    run: async (handler, signal) => {
      while (!signal.aborted) {
        const index = this.pending.findIndex(
          (item) =>
            item.available <= Date.parse(this.clock.now()) &&
            (item.retryAfterReal ?? 0) <= Date.now() &&
            (!this.group(item.delivery) ||
              (![...this.running.values()].some(
                (running) => this.group(running) === this.group(item.delivery),
              ) &&
                !this.pending.some(
                  (earlier) =>
                    this.group(earlier.delivery) ===
                      this.group(item.delivery) &&
                    Number(earlier.delivery.id) < Number(item.delivery.id),
                ))),
        );
        if (index < 0) {
          await new Promise<void>((resolve) => {
            const now = Date.parse(this.clock.now());
            const due = this.pending.length
              ? this.pending.reduce(
                  (earliest, item) =>
                    Math.min(
                      earliest,
                      Math.max(
                        item.available - now,
                        (item.retryAfterReal ?? 0) - Date.now(),
                        0,
                      ),
                    ),
                  Number.POSITIVE_INFINITY,
                )
              : undefined;
            const timer =
              due === undefined
                ? undefined
                : setTimeout(
                    done,
                    this.systemClock
                      ? Math.min(2147483647, Math.max(1, due))
                      : Math.min(10, Math.max(1, due)),
                  );
            const waiters = this.waiters;
            function done() {
              if (timer !== undefined) clearTimeout(timer);
              signal.removeEventListener("abort", done);
              waiters.delete(done);
              resolve();
            }
            waiters.add(done);
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
          continue;
        }
        const [item] = this.pending.splice(index, 1);
        if (!item) continue;
        this.running.set(item.delivery.id, item.delivery);
        let failed = false;
        try {
          const result = await handler([structuredClone(item.delivery)]);
          const action = result.find((r) => r.deliveryId === item.delivery.id);
          if (action?.action === "ack") continue;
          failed = true;
          item.available =
            Date.parse(this.clock.now()) +
            (action?.action === "retry" ? (action.delaySec ?? 0) : 0) * 1000;
        } catch {
          failed = true;
          item.available = Date.parse(this.clock.now());
        } finally {
          this.running.delete(item.delivery.id);
        }
        if (failed && item.delivery.attempt >= this.maxAttempts) {
          this.logger.error("Dropping queue message after maximum attempts", {
            id: item.delivery.id,
            topic: item.delivery.topic,
            attempts: item.delivery.attempt,
          });
          continue;
        }
        item.retryAfterReal =
          Date.now() +
          Math.min(1000, 5 * 2 ** Math.min(item.delivery.attempt - 1, 8));
        item.delivery.attempt++;
        this.pending.push(item);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}
export function create({
  config,
  bindings,
  topics,
}: CreateContext<
  QueueConfig,
  { clock?: Clock; logger?: Pick<Logger, "error"> }
>): MemoryQueue {
  return new MemoryQueue(config, bindings.clock, bindings.logger, topics);
}
