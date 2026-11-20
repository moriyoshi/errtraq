import {
  type Clock,
  type Delivery,
  type Queue,
  toTimestamp,
} from "@errtraq/core";
import { configSchema, type QueueConfig } from "./stack.js";

export { infra, manifest } from "./stack.js";

interface Pending {
  delivery: Delivery;
  available: number;
}
export class MemoryQueue implements Queue {
  readonly capabilities: Queue["capabilities"];
  private readonly pending: Pending[] = [];
  private readonly running = new Map<string, Delivery>();
  private nextId = 0;
  private readonly clock: Clock;
  constructor(
    config: QueueConfig = {},
    clock: Clock = { now: () => toTimestamp(new Date()) },
  ) {
    this.clock = clock;
    configSchema.parse(config);
    this.capabilities = {
      delivery: "pull",
      delay: true,
      dlq: false,
      maxBytes: 262144,
    };
  }
  /** Snapshot of messages currently being handled, for local observability. */
  get inFlight(): readonly Delivery[] {
    return structuredClone([...this.running.values()]);
  }
  producer: Queue["producer"] = {
    send: async (topic, messages, options) => {
      for (const message of messages) {
        const bytes = new TextEncoder().encode(
          JSON.stringify(message),
        ).byteLength;
        if (bytes > this.capabilities.maxBytes)
          throw new Error("Message exceeds queue maxBytes");
      }
      for (const message of messages)
        this.pending.push({
          delivery: {
            id: String(++this.nextId),
            topic,
            message: structuredClone(message),
            attempt: 1,
          },
          available:
            Date.parse(this.clock.now()) + (options?.delaySec ?? 0) * 1000,
        });
    },
  };
  pull: NonNullable<Queue["pull"]> = {
    run: async (handler, signal) => {
      while (!signal.aborted) {
        const index = this.pending.findIndex(
          (item) => item.available <= Date.parse(this.clock.now()),
        );
        if (index < 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, 5);
            function done() {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            }
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
          continue;
        }
        const [item] = this.pending.splice(index, 1);
        if (!item) continue;
        this.running.set(item.delivery.id, item.delivery);
        try {
          const result = await handler([structuredClone(item.delivery)]);
          const action = result.find((r) => r.deliveryId === item.delivery.id);
          if (action?.action === "ack") continue;
          item.available =
            Date.parse(this.clock.now()) +
            (action?.action === "retry" ? (action.delaySec ?? 0) : 0) * 1000;
        } catch {
          item.available = Date.parse(this.clock.now());
        } finally {
          this.running.delete(item.delivery.id);
        }
        item.delivery.attempt++;
        this.pending.push(item);
      }
    },
  };
}
export function create(
  config: QueueConfig = {},
  bindings: { clock?: Clock } = {},
): MemoryQueue {
  return new MemoryQueue(config, bindings.clock);
}
