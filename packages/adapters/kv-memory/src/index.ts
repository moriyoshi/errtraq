import {
  type Clock,
  type CreateContext,
  InvalidCounterError,
  type KV,
  toTimestamp,
} from "@errtraq/core";
import { configSchema, type KvConfig } from "./stack.js";

export { infra, manifest } from "./stack.js";
export class MemoryKV implements KV {
  private operations = 0;
  private readonly rows = new Map<
    string,
    { value: string; expiresAt?: number }
  >();
  constructor(
    private readonly clock: Clock = { now: () => toTimestamp(new Date()) },
  ) {}
  private current(key: string) {
    if (++this.operations % 64 === 0) {
      const now = Date.parse(this.clock.now());
      for (const [k, row] of this.rows)
        if (row.expiresAt !== undefined && row.expiresAt <= now)
          this.rows.delete(k);
    }
    const row = this.rows.get(key);
    if (
      row?.expiresAt !== undefined &&
      row.expiresAt <= Date.parse(this.clock.now())
    ) {
      this.rows.delete(key);
      return undefined;
    }
    return row;
  }
  async get(key: string) {
    return this.current(key)?.value ?? null;
  }
  async put(key: string, value: string, options?: { ttlSec?: number }) {
    this.rows.set(key, {
      value,
      ...(options?.ttlSec === undefined
        ? {}
        : { expiresAt: Date.parse(this.clock.now()) + options.ttlSec * 1000 }),
    });
  }
  async delete(key: string) {
    this.rows.delete(key);
  }
  async increment(key: string, by: number, options?: { ttlSec?: number }) {
    const current = this.current(key);
    if (
      current &&
      (!/^-?\d+$/.test(current.value) ||
        !Number.isSafeInteger(Number(current.value)))
    )
      throw new InvalidCounterError("Counter must be decimal");
    if (!Number.isSafeInteger(by))
      throw new InvalidCounterError("Increment must be a safe integer");
    const value = Number(current?.value ?? "0") + by;
    if (!Number.isSafeInteger(value))
      throw new InvalidCounterError("Counter must be a safe integer");
    this.rows.set(key, {
      value: String(value),
      ...(current?.expiresAt !== undefined
        ? { expiresAt: current.expiresAt }
        : !current && options?.ttlSec !== undefined
          ? { expiresAt: Date.parse(this.clock.now()) + options.ttlSec * 1000 }
          : {}),
    });
    return value;
  }
}
export function create({
  config,
  bindings,
}: CreateContext<KvConfig, { clock?: Clock }>): MemoryKV {
  configSchema.parse(config);
  return new MemoryKV(bindings.clock);
}
