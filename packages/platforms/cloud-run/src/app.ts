import {
  type ActiveStore,
  ARCHIVE_PROJECT_TOPIC,
  type BatchHandler,
  type BlobStore,
  type Clock,
  ConsumerService,
  CRON_JOBS,
  type CronHandler,
  createCronHandler,
  cronJobRole,
  FUNCTION_CRON_JOBS,
  type FunctionRole,
  IngestService,
  type KV,
  type Logger,
  projectReader,
  type Queue,
  type RateRejectionConfig,
  RecordHandler,
  releaseReader,
  toTimestamp,
} from "@moriyoshi/errtraq-core/runtime";
import { createApiApp, createIngestApp } from "@moriyoshi/errtraq-http";
import { Hono } from "hono";
import {
  BOOTSTRAP_ROUTE,
  CRON_ROUTE_PREFIX,
  HEALTH_ROUTE,
  PUSH_ROUTE_PREFIX,
} from "./stack.js";

type Headers = globalThis.Headers;
export interface HandlerOptions {
  roles: readonly FunctionRole[];
  recordMode?: "direct" | "grouped";
  rateRejection?: RateRejectionConfig;
  rateLimit?: number | null;
  http: readonly FunctionRole[];
  adapters: {
    store?: ActiveStore;
    blob?: BlobStore;
    queue?: Queue;
    kv?: KV;
  };
  /** Physical queues this function consumes; a push to any other path is a 404. */
  queuePhysicals?: readonly string[];
  /** Authenticates the Cloud Scheduler call of a cron route; absent rejects every cron request. */
  verifyCron?: (headers: Headers) => Promise<boolean>;
  /** Authenticates the operator call of the bootstrap route; absent rejects every request. */
  verifyOperator?: (headers: Headers) => Promise<boolean>;
  /** The bootstrap role's handler (see `createBootstrapHandler`); only that role serves the route. */
  bootstrap?: (body: unknown) => Promise<unknown>;
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
/** Parse the platform-delivered limit; missing uses the IngestService default. */
export function cloudRunRateLimit(
  value: string | undefined,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === "disabled") return null;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Invalid ingest rate limit");
  return Number(value);
}
/** Share successful initialization while allowing the next request to retry a failure. */
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
/** An empty-bodied response (a 204 must not carry a body, and the Response constructor enforces it). */
const text = (status: number) => new Response(null, { status });
/**
 * The Web `fetch` handler of one Cloud Run function. Public routes are the ingest and API apps
 * (they authenticate DSN keys and tokens); the internal routes are `POST /_errtraq/push/<physical>`
 * (Pub/Sub push, authenticated by the queue adapter's `verifyPush`), `POST /_errtraq/cron/<job>`
 * (Cloud Scheduler) and `POST /_errtraq/bootstrap`, each behind its own OIDC verifier.
 */
export function createHandler(
  options: HandlerOptions,
): (request: Request) => Promise<Response> {
  const { roles, adapters } = options;
  if (roles.includes("archive"))
    // TODO(G-archive): the archive tier on GCP is deferred (GCP_PLAN D14).
    throw new Error("The archive role is not supported on Cloud Run yet");
  const clock = options.clock ?? { now: () => toTimestamp(new Date()) };
  const log = options.logger ?? logger;
  const app = new Hono({ strict: false });
  app.get(HEALTH_ROUTE, (c) => c.json({ status: "ok" }));
  if (options.http.includes("ingest")) {
    if (!adapters.store || !adapters.blob || !adapters.queue || !adapters.kv)
      throw new Error("Ingest adapters are missing");
    app.route(
      "/",
      createIngestApp(
        new IngestService({
          store: adapters.store,
          rateLimit: options.rateLimit,
          blobs: adapters.blob,
          queue: adapters.queue.producer,
          kv: adapters.kv,
          clock,
          logger: log,
        }),
        log,
        { cors: false },
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
        kv: adapters.kv,
        rateRejection: options.rateRejection,
        clock,
        logger: log,
      }),
    );
  }
  const grouped = options.recordMode === "grouped";
  if (
    grouped &&
    roles.includes("consumer") &&
    options.rateRejection?.issueRateLimit &&
    !adapters.store
  )
    throw new Error(
      "Grouped consumer adapters are missing project read access",
    );
  const consumer =
    roles.includes("consumer") &&
    adapters.blob &&
    (grouped ? adapters.queue : adapters.store)
      ? new ConsumerService({
          ...(grouped
            ? {
                projects:
                  options.rateRejection?.issueRateLimit && adapters.store
                    ? projectReader(adapters.store)
                    : undefined,
              }
            : { store: adapters.store }),
          releases: adapters.store ? releaseReader(adapters.store) : undefined,
          blobs: adapters.blob,
          recordMode: options.recordMode,
          rateRejection: options.rateRejection,
          kv: adapters.kv,
          queue: adapters.queue,
          logger: log,
        })
      : undefined;
  const record =
    roles.includes("record") && adapters.store && adapters.blob
      ? new RecordHandler({
          store: adapters.store,
          blobs: adapters.blob,
          kv: adapters.kv,
          rateRejection: options.rateRejection,
          logger: log,
        })
      : undefined;
  const dispatch: BatchHandler = async (batch) => {
    const results: Awaited<ReturnType<BatchHandler>> = [];
    for (const topic of ["ingest", "record"]) {
      const selected = batch.filter((delivery) => delivery.topic === topic);
      if (!selected.length) continue;
      const handler = topic === "ingest" ? consumer?.handle : record?.handle;
      if (!handler)
        results.push(
          ...selected.map((delivery) => ({
            deliveryId: delivery.id,
            action: "retry" as const,
          })),
        );
      else results.push(...(await handler(selected)));
    }
    for (const delivery of batch)
      if (
        delivery.topic !== "ingest" &&
        delivery.topic !== "record" &&
        delivery.topic !== ARCHIVE_PROJECT_TOPIC
      )
        results.push({ deliveryId: delivery.id, action: "retry" });
    // The archive topic has no consumer here; retry until the dead-letter policy takes it.
    for (const delivery of batch)
      if (delivery.topic === ARCHIVE_PROJECT_TOPIC)
        results.push({ deliveryId: delivery.id, action: "retry" });
    return results;
  };
  // The jobs a function platform schedules without an archive (the others need the archive tier).
  const hostedJobs = new Set<string>(
    roles.includes("cron")
      ? CRON_JOBS.filter(
          (job) =>
            cronJobRole(job, false) === "cron" &&
            FUNCTION_CRON_JOBS.has(job.name),
        ).map((job) => job.name)
      : [],
  );
  const physicals = new Set(options.queuePhysicals ?? []);
  app.post(`${PUSH_ROUTE_PREFIX}:physical`, async (c) => {
    const physical = c.req.param("physical");
    const push = adapters.queue?.push;
    if (!push || (!consumer && !record) || !physicals.has(physical))
      return text(404);
    // The adapter authenticates (verifyPush), maps the `subscription` field to its consumer
    // route and answers with the status Pub/Sub understands (204 acks, anything else nacks).
    const result = await push.handle(
      {
        method: "POST",
        headers: c.req.raw.headers,
        body: await c.req.text(),
      },
      dispatch,
    );
    return text((result as { status: number }).status);
  });
  app.post(`${CRON_ROUTE_PREFIX}:job`, async (c) => {
    const name = c.req.param("job");
    if (!hostedJobs.has(name)) return text(404);
    if (!(await options.verifyCron?.(c.req.raw.headers))) return text(401);
    try {
      await (options.cronHandler ?? defaultCron(options, log))(
        name,
        clock.now(),
      );
      return text(204);
    } catch {
      log.error("Cron job failed", { job: name });
      // A non-2xx makes Cloud Scheduler retry per the job's retry configuration.
      return text(500);
    }
  });
  if (options.bootstrap) {
    const bootstrap = options.bootstrap;
    app.post(BOOTSTRAP_ROUTE, async (c) => {
      if (!(await options.verifyOperator?.(c.req.raw.headers)))
        return text(401);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return text(400);
      }
      return c.json((await bootstrap(body)) as object);
    });
  }
  return async (request) => app.fetch(request);
}
function defaultCron(options: HandlerOptions, log: Logger): CronHandler {
  const { adapters } = options;
  return createCronHandler(
    log,
    adapters.blob && adapters.queue
      ? { blobs: adapters.blob, queue: adapters.queue.producer }
      : undefined,
    adapters.blob && adapters.store
      ? {
          projects: adapters.store.projects,
          releases: adapters.store.releases,
          blobs: adapters.blob,
        }
      : undefined,
    undefined,
    adapters.blob && adapters.store
      ? { store: adapters.store, blobs: adapters.blob, archived: false }
      : undefined,
  );
}
