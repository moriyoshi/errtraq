import {
  type ActiveStore,
  type BlobStore,
  type Clock,
  ConsumerService,
  type CronHandler,
  type CronJob,
  IngestService,
  type KV,
  type Logger,
  type Queue,
  toTimestamp,
} from "@errtraq/core";
import { createApiApp, createIngestApp } from "@errtraq/http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { configSchema, type StandaloneConfig } from "./stack.js";

export { infra, manifest } from "./stack.js";
export interface Bindings {
  store: ActiveStore;
  queue: Queue;
  blobs: BlobStore;
  kv: KV;
  clock?: Clock;
  logger?: Logger;
  jobs?: CronJob[];
  cronHandler?: CronHandler;
  maxEnvelopeBytes?: number;
}
const defaultLogger: Logger = {
  debug: () => {},
  info: (m, f) => console.info(m, f ?? ""),
  warn: (m, f) => console.warn(m, f ?? ""),
  error: (m, f) => console.error(m, f ?? ""),
};
/** Five-field UTC cron matching: wildcards, steps, comma lists and integer values. */
export function cronMatches(schedule: string, date: Date): boolean {
  const fields = schedule.trim().split(/\s+/);
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const;
  if (
    fields.length !== 5 ||
    fields.some(
      (field, index) =>
        !field ||
        field.split(",").some((part) => {
          if (part === "*") return false;
          if (/^\*\/\d+$/.test(part)) return Number(part.slice(2)) < 1;
          if (!/^\d+$/.test(part)) return true;
          const bounds = ranges[index];
          return (
            !bounds || Number(part) < bounds[0] || Number(part) > bounds[1]
          );
        }),
    )
  )
    throw new RangeError("Unsupported cron expression");
  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];
  const matches = fields.map((field, i) =>
    field
      ?.split(",")
      .some(
        (part) =>
          part === "*" ||
          (/^\*\/\d+$/.test(part) &&
            Number(part.slice(2)) > 0 &&
            ((values[i] ?? 0) - (ranges[i]?.[0] ?? 0)) %
              Number(part.slice(2)) ===
              0) ||
          (/^\d+$/.test(part) && Number(part) === values[i]),
      ),
  );
  if (fields[2] !== "*" && fields[4] !== "*")
    return !!(
      matches[0] &&
      matches[1] &&
      matches[3] &&
      (matches[2] || matches[4])
    );
  return matches.every(Boolean);
}
export function create(config: StandaloneConfig, bindings: Bindings) {
  const cfg = configSchema.parse(config);
  const clock = bindings.clock ?? { now: () => toTimestamp(new Date()) };
  const logger = bindings.logger ?? defaultLogger;
  return {
    async start() {
      if (!bindings.queue.pull)
        throw new Error("Standalone requires a pull queue");
      for (const job of bindings.jobs ?? [])
        cronMatches(job.schedule, new Date());
      if (bindings.jobs?.length && !bindings.cronHandler)
        throw new Error("Cron handler required");
      const limit = bindings.maxEnvelopeBytes ?? 1024 * 1024;
      const ingest = new IngestService({
        store: bindings.store,
        blobs: bindings.blobs,
        queue: bindings.queue.producer,
        kv: bindings.kv,
        clock,
        logger,
        maxBytes: limit,
      });
      const consumer = new ConsumerService({
        store: bindings.store,
        blobs: bindings.blobs,
        kv: bindings.kv,
        logger,
        maxEnvelopeBytes: limit,
      });
      const app = new Hono();
      app.route("/", createIngestApp(ingest));
      app.route(
        "/",
        createApiApp({ store: bindings.store, clock, blobs: bindings.blobs }),
      );
      const server = serve({
        fetch: app.fetch,
        hostname: cfg.host,
        port: cfg.port,
      });
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const abort = new AbortController();
      const running = bindings.queue.pull.run(consumer.handle, abort.signal);
      let minute = -1;
      const timer = setInterval(() => {
        const now = new Date();
        const current = Math.floor(now.valueOf() / 60000);
        if (current === minute) return;
        minute = current;
        for (const job of bindings.jobs ?? [])
          if (cronMatches(job.schedule, now))
            void Promise.resolve()
              .then(() => bindings.cronHandler?.(job.name, toTimestamp(now)))
              .catch((error) =>
                logger.error("Cron failed", { error: String(error) }),
              );
      }, 1000);
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Unexpected server address");
      let closed = false;
      return {
        host: cfg.host,
        port: address.port,
        async close() {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          abort.abort();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          await running;
        },
      };
    },
  };
}
