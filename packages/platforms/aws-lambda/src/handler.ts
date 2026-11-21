import {
  type ActiveStore,
  type BlobStore,
  type Clock,
  ConsumerService,
  CRON_JOBS,
  type CronHandler,
  createCronHandler,
  type FunctionRole,
  IngestService,
  type KV,
  type Logger,
  type Queue,
  toTimestamp,
} from "@errtraq/core";
import { createApiApp, createIngestApp } from "@errtraq/http";
import { Hono } from "hono";
import { handle, type LambdaEvent } from "hono/aws-lambda";

export interface HandlerOptions {
  roles: readonly FunctionRole[];
  http: readonly FunctionRole[];
  adapters: { store?: ActiveStore; blob?: BlobStore; queue?: Queue; kv?: KV };
  clock?: Clock;
  logger?: Logger;
  cronHandler?: CronHandler;
}
const logger: Logger = {
  debug: () => {},
  info: (message, fields) => console.info(message, fields ?? ""),
  warn: (message, fields) => console.warn(message, fields ?? ""),
  error: (message, fields) => console.error(message, fields ?? ""),
};
/** Share successful initialization while allowing the next invocation to retry a failure. */
export function retryableInitialization<T>(
  initialize: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= Promise.resolve()
      .then(initialize)
      .catch((error) => {
        pending = undefined;
        throw error;
      }));
}
/** Lambda URLs use the Hono AWS adapter; SQS acknowledgement belongs to the queue adapter. */
export function createHandler(
  options: HandlerOptions,
): (event: unknown) => Promise<unknown> {
  const { roles, adapters } = options;
  const clock = options.clock ?? { now: () => toTimestamp(new Date()) };
  const log = options.logger ?? logger;
  const app = new Hono({ strict: false });
  if (options.http.includes("ingest")) {
    if (!adapters.store || !adapters.blob || !adapters.queue || !adapters.kv)
      throw new Error("Ingest adapters are missing");
    app.route(
      "/",
      createIngestApp(
        new IngestService({
          store: adapters.store,
          blobs: adapters.blob,
          queue: adapters.queue.producer,
          kv: adapters.kv,
          clock,
          logger: log,
        }),
        log,
      ),
    );
  }
  if (options.http.includes("api")) {
    if (!adapters.store || !adapters.blob)
      throw new Error("API adapters are missing");
    app.route(
      "/",
      createApiApp({
        store: adapters.store,
        blobs: adapters.blob,
        clock,
        logger: log,
      }),
    );
  }
  const http = handle(app);
  const consumer =
    roles.includes("consumer") && adapters.store && adapters.blob
      ? new ConsumerService({
          store: adapters.store,
          blobs: adapters.blob,
          logger: log,
        })
      : undefined;
  return async (event: unknown) => {
    if (!event || typeof event !== "object") {
      if (roles.includes("cron")) {
        log.error("Unknown or missing cron job");
        return;
      }
      throw new Error("Invalid Lambda event");
    }
    if ("Records" in event) {
      if (!consumer || !adapters.queue?.push)
        throw new Error("Queue consumer is unavailable");
      return adapters.queue.push.handle(event, consumer.handle);
    }
    if (
      "job" in event ||
      (!("requestContext" in event) && roles.includes("cron"))
    ) {
      if (!roles.includes("cron")) {
        log.error("Unknown or missing cron job");
        return;
      }
      const name =
        "job" in event && typeof event.job === "string" ? event.job : "";
      if (!CRON_JOBS.some((job) => job.name === name)) {
        log.error("Unknown or missing cron job");
        return;
      }
      await (options.cronHandler ?? createCronHandler(log))(name, clock.now());
      return;
    }
    if (!("requestContext" in event) || !options.http.length)
      throw new Error("Unsupported Lambda event");
    return http(event as LambdaEvent);
  };
}
