export {
  type BootstrapHandlerOptions,
  bootstrapSecretName,
  createBootstrapHandler,
} from "./bootstrap-handler.js";
export { awsBootstrapVault } from "./bootstrap-vault.js";
export { type LambdaCredentials, lambdaAwsCredentials } from "./credentials.js";
export { createSecretsManagerSource, SecretReadError } from "./secrets.js";

import {
  type ActiveStore,
  ARCHIVE_PROJECT_TOPIC,
  type ArchiveStore,
  ArchiveWorker,
  type AuthSettings,
  type BatchHandler,
  type BlobStore,
  type Clock,
  ConsumerService,
  CRON_JOBS,
  type CronHandler,
  createCronHandler,
  cronJobRole,
  type FunctionRole,
  IngestService,
  type KV,
  type Logger,
  parseAuthSettings,
  projectReader,
  type Queue,
  type RateRejectionConfig,
  RecordHandler,
  releaseReader,
  toTimestamp,
} from "@moriyoshi/errtraq-core/runtime";
import { createApiApp, createIngestApp } from "@moriyoshi/errtraq-http";
import { Hono } from "hono";
import { handle, type LambdaEvent } from "hono/aws-lambda";

export interface HandlerOptions {
  roles: readonly FunctionRole[];
  recordMode?: "direct" | "grouped";
  rateRejection?: RateRejectionConfig;
  rateLimit?: number | null;
  /**
   * Public ingest URL for the DSNs of the API's key list (`ERRTRAQ_PUBLIC_INGEST_URL`). The API
   * adds no CORS headers: the function URL's CORS block carries the browser policy.
   */
  ingestUrl?: string;
  /** OIDC Bearer and proxy-assertion settings (`ERRTRAQ_AUTH_CONFIG`); absent means API tokens only. */
  auth?: AuthSettings;
  http: readonly FunctionRole[];
  adapters: {
    store?: ActiveStore;
    blob?: BlobStore;
    queue?: Queue;
    kv?: KV;
    /**
     * Selected archive. The `archive` role runs the worker, the planner and housekeeping with it;
     * the `api` role reads it for federated queries.
     */
    archive?: ArchiveStore;
  };
  /** Stack-wide bound on the life of an archived event, in days (D12); housekeeping only. */
  archiveRetentionDays?: number;
  /** The archive function's timeout: the worker stops starting batches at 60% of it. */
  archiveInvocationTimeoutMs?: number;
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
export function lambdaRateLimit(
  value: string | undefined,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === "disabled") return null;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Invalid Lambda ingest rate limit");
  return Number(value);
}
/** Parse the platform-delivered sign-in settings JSON; missing or empty means none. */
export function lambdaAuthSettings(
  value: string | undefined,
): AuthSettings | undefined {
  if (value === undefined || value === "") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("Invalid sign-in settings JSON");
  }
  return parseAuthSettings(raw);
}
/** Parse the operator-supplied public ingest URL; missing or empty means the key list has no `dsn`. */
export function lambdaIngestUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // fall through to the error
  }
  if (!url || !["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid public ingest URL");
  return value;
}
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
        archive: adapters.archive,
        ...(options.ingestUrl ? { ingestUrl: options.ingestUrl } : {}),
        ...(options.auth ? { auth: options.auth } : {}),
      }),
    );
  }
  const http = handle(app);
  // D6: the archive role hosts the per-project worker, which also feeds the planner's and the
  // housekeeping job's lease discipline.
  const archival =
    roles.includes("archive") &&
    adapters.archive &&
    adapters.store &&
    adapters.blob &&
    adapters.queue
      ? new ArchiveWorker({
          store: adapters.store,
          blobs: adapters.blob,
          archive: adapters.archive,
          queue: adapters.queue.producer,
          logger: log,
          clock,
          ...(options.archiveInvocationTimeoutMs === undefined
            ? {}
            : { invocationTimeoutMs: options.archiveInvocationTimeoutMs }),
        })
      : undefined;
  if (roles.includes("archive") && !archival)
    throw new Error("Archive adapters are missing");
  const hostsCron = roles.includes("cron") || roles.includes("archive");
  const hostedJobs = new Set<string>(
    CRON_JOBS.filter((job) =>
      roles.includes(cronJobRole(job, roles.includes("archive"))),
    ).map((job) => job.name),
  );
  const grouped = options.recordMode === "grouped";
  // The grouped consumer gets project reads only, and only when a per-issue limit needs them.
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
          // Symbolication reads debug-ID owners only (`release-read`), in both record modes.
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
    for (const topic of ["ingest", "record", ARCHIVE_PROJECT_TOPIC]) {
      const selected = batch.filter((delivery) => delivery.topic === topic);
      if (!selected.length) continue;
      const handler =
        topic === "ingest"
          ? consumer?.handle
          : topic === "record"
            ? record?.handle
            : archival?.handle;
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
    return results;
  };
  return async (event: unknown) => {
    if (!event || typeof event !== "object") {
      if (hostsCron) {
        log.error("Unknown or missing cron job");
        return;
      }
      throw new Error("Invalid Lambda event");
    }
    if ("Records" in event) {
      if ((!consumer && !record && !archival) || !adapters.queue?.push)
        throw new Error("Queue consumer is unavailable");
      return adapters.queue.push.handle(event, dispatch);
    }
    if ("job" in event || (!("requestContext" in event) && hostsCron)) {
      if (!hostsCron) {
        log.error("Unknown or missing cron job");
        return;
      }
      const name =
        "job" in event && typeof event.job === "string" ? event.job : "";
      if (!hostedJobs.has(name)) {
        log.error("Unknown or missing cron job");
        return;
      }
      await (
        options.cronHandler ??
        createCronHandler(
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
          // The archive role runs the planner on the queue it consumes from (a continuation is a
          // message to itself).
          archival && adapters.store && adapters.queue
            ? {
                projects: adapters.store.projects,
                queue: adapters.queue.producer,
              }
            : undefined,
          adapters.blob && adapters.store
            ? {
                store: adapters.store,
                blobs: adapters.blob,
                archived: !!archival,
                // The lease and the engine live here, so housekeeping runs on this role (D6).
                housekeeping:
                  archival && adapters.archive
                    ? {
                        store: adapters.store,
                        blobs: adapters.blob,
                        archive: adapters.archive,
                        worker: archival,
                        ...(options.archiveRetentionDays === undefined
                          ? {}
                          : {
                              archiveRetentionDays:
                                options.archiveRetentionDays,
                            }),
                        // TODO(M4l): snapshotExpiryDays once the engine has a verified expiry path.
                      }
                    : undefined,
              }
            : undefined,
        )
      )(name, clock.now());
      return;
    }
    if (!("requestContext" in event) || !options.http.length)
      throw new Error("Unsupported Lambda event");
    return http(event as LambdaEvent);
  };
}
