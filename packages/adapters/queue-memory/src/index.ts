import {
  type Clock,
  type Delivery,
  type Logger,
  type Queue,
  toTimestamp,
} from "@errtraq/core";
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
  constructor(
    config: QueueConfig = {},
    clock?: Clock,
    logger: Pick<Logger, "error"> = {
      error: (message, fields) => console.error(message, fields),
    },
  ) {
    this.systemClock = clock === undefined;
    this.clock = clock ?? { now: () => toTimestamp(new Date()) };
    this.maxAttempts = configSchema.parse(config).maxAttempts;
    this.logger = logger;
    this.capabilities = {
      delivery: "pull",
      delay: true,
      dlq: false,
      maxBytes: QUEUE_MAX_BYTES,
    };
  }
  /** Snapshot of messages currently being handled, for local observability. */
  get inFlight(): readonly Delivery[] {
    return structuredClone([...this.running.values()]);
  }
  producer: Queue["producer"] = {
    send: async (topic, messages, options) => {
      const delay = options?.delaySec ?? 0;
      if (!Number.isFinite(delay) || delay < 0)
        throw new RangeError("Invalid queue delay");
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
            (item.retryAfterReal ?? 0) <= Date.now(),
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
export function create(
  config: QueueConfig = {},
  bindings: { clock?: Clock; logger?: Pick<Logger, "error"> } = {},
): MemoryQueue {
  return new MemoryQueue(config, bindings.clock, bindings.logger);
}
