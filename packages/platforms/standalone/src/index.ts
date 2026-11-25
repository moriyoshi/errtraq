import { serve } from "@hono/node-server";
import {
  type ActiveStore,
  ARCHIVE_PROJECT_TOPIC,
  type ArchiveStore,
  ArchiveWorker,
  type BatchHandler,
  type BlobStore,
  bootstrapProject,
  type Clock,
  ConsumerService,
  CRON_JOBS,
  type CreateContext,
  type CronHandler,
  createCronHandler,
  IngestService,
  type KV,
  type Logger,
  projectReader,
  type Queue,
  RecordHandler,
  recoverStagedEnvelopes,
  releaseReader,
  runBundleCleanup,
  toTimestamp,
  WebCryptoIdGen,
} from "@moriyoshi/errtraq-core";
import { createApiApp, createIngestApp } from "@moriyoshi/errtraq-http";
import { Hono } from "hono";
import { configSchema, type StandaloneConfig } from "./stack.js";
import type { DevTokenManager } from "./token.js";

export { infra, manifest } from "./stack.js";
export interface Bindings {
  store: ActiveStore;
  queue: Queue;
  blob: BlobStore;
  kv: KV;
  clock?: Clock;
  logger?: Logger;
  cronHandler?: CronHandler;
  /** Selected archive; hosts the `archive.project` worker in this single process. */
  archive?: ArchiveStore;
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
  if (!fields[2]?.startsWith("*") && !fields[4]?.startsWith("*"))
    return !!(
      matches[0] &&
      matches[1] &&
      matches[3] &&
      (matches[2] || matches[4])
    );
  return matches.every(Boolean);
}
export function create({
  config,
  bindings: runtimeBindings,
  dependencies,
  cronJobs = [],
  recordMode = "direct",
  rateRejection,
}: CreateContext<StandaloneConfig, Partial<Bindings>, Bindings>) {
  const bindings = { ...dependencies, ...runtimeBindings };
  const cfg = configSchema.parse(config);
  const clock = bindings.clock ?? { now: () => toTimestamp(new Date()) };
  const logger = bindings.logger ?? defaultLogger;
  let closeCurrent: (() => Promise<void>) | undefined;
  return {
    async close() {
      await closeCurrent?.();
    },
    async prepare(rotate: boolean, devToken: DevTokenManager) {
      await bindings.store.migrate();
      // The single process owns the archive table too (`errtraq migrate` does the same offline).
      const archive = bindings.archive as
        | (ArchiveStore & { ensureTable?: () => Promise<unknown> })
        | undefined;
      await archive?.ensureTable?.();
      const ids = new WebCryptoIdGen();
      const project = await bootstrapProject({
        store: bindings.store,
        kv: bindings.kv,
        ids,
        orgSlug: "default",
        projectSlug: "default",
      });
      const token = await devToken(
        bindings.store,
        ids,
        project.org.id,
        cfg.tokenDirectory,
        rotate,
      );
      return {
        token,
        publicKey: project.key.publicKey,
        projectId: project.project.id,
      };
    },
    async start() {
      if (!bindings.queue.pull)
        throw new Error("Standalone requires a pull queue");
      for (const name of cronJobs)
        if (!CRON_JOBS.some((job) => job.name === name))
          throw new Error(`Unknown cron job ${name}`);
      const jobs = CRON_JOBS.filter((job) => cronJobs.includes(job.name));
      for (const job of jobs) cronMatches(job.schedule, new Date());
      if (!bindings.queue.idle)
        throw new Error(
          "Standalone requires queue idle observation for graceful shutdown",
        );
      const limit = bindings.maxEnvelopeBytes ?? 1024 * 1024;
      const ingest = new IngestService({
        store: bindings.store,
        blobs: bindings.blob,
        queue: bindings.queue.producer,
        kv: bindings.kv,
        clock,
        logger,
        maxBytes: limit,
        rateLimit: cfg.rateLimit,
        rateWindowSec: cfg.rateWindowSec,
      });
      const consumer = new ConsumerService({
        ...(recordMode === "grouped"
          ? {
              projects: rateRejection?.issueRateLimit
                ? projectReader(bindings.store)
                : undefined,
            }
          : { store: bindings.store }),
        releases: releaseReader(bindings.store),
        blobs: bindings.blob,
        kv: bindings.kv,
        queue: bindings.queue,
        recordMode,
        rateRejection,
        logger,
        maxEnvelopeBytes: limit,
      });
      await recoverStagedEnvelopes(
        bindings.blob,
        bindings.queue.producer,
        logger,
      );
      const app = new Hono({ strict: false });
      app.get("/health", (c) => c.json({ status: "ok" }));
      if (cfg.http.includes("ingest"))
        app.route("/", createIngestApp(ingest, logger));
      if (cfg.http.includes("api"))
        app.route(
          "/",
          createApiApp({
            store: bindings.store,
            clock,
            blobs: bindings.blob,
            kv: bindings.kv,
            rateRejection,
            logger,
            archive: bindings.archive,
          }),
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
      const record =
        recordMode === "grouped"
          ? new RecordHandler({
              store: bindings.store,
              blobs: bindings.blob,
              kv: bindings.kv,
              rateRejection,
              logger,
            })
          : undefined;
      // The single process hosts every handler; AWS routes this topic to the archive role (M4i).
      const archival = bindings.archive
        ? new ArchiveWorker({
            store: bindings.store,
            blobs: bindings.blob,
            archive: bindings.archive,
            queue: bindings.queue.producer,
            logger,
            clock,
          })
        : undefined;
      const dispatch: BatchHandler = async (batch) => {
        const result: Awaited<ReturnType<BatchHandler>> = [];
        for (const topic of ["ingest", "record", ARCHIVE_PROJECT_TOPIC]) {
          const selected = batch.filter((item) => item.topic === topic);
          if (!selected.length) continue;
          const handler =
            topic === "ingest"
              ? consumer.handle
              : topic === "record"
                ? record?.handle
                : archival?.handle;
          if (handler) result.push(...(await handler(selected)));
          else
            result.push(
              ...selected.map((item) => ({
                deliveryId: item.id,
                action: "retry" as const,
              })),
            );
        }
        for (const item of batch)
          if (
            item.topic !== "ingest" &&
            item.topic !== "record" &&
            item.topic !== ARCHIVE_PROJECT_TOPIC
          )
            result.push({ deliveryId: item.id, action: "retry" });
        return result;
      };
      const running = bindings.queue.pull.run(dispatch, abort.signal);
      // Standalone has no scheduler: it drives the bundle-cleanup job itself (also on start, to
      // expire chunks and pending bundles left by an earlier run), so abandoned uploads on
      // blob-fs, which has no lifecycle rules, do not accumulate.
      const cleanupJob = () =>
        runBundleCleanup(
          {
            projects: bindings.store.projects,
            releases: bindings.store.releases,
            blobs: bindings.blob,
            logger,
            persistCursor: true,
          },
          clock.now(),
        ).catch((error) =>
          logger.error("Bundle cleanup failed", { error: String(error) }),
        );
      void cleanupJob();
      const cleanupTimer = setInterval(() => void cleanupJob(), 15 * 60 * 1000);
      cleanupTimer.unref();
      // The single process hosts the cron jobs too. An embedder may supply its own handler;
      // otherwise the core registry runs the archive planner and the retention job.
      // TODO(M4j): erasure-worker is not scheduled until its handler exists.
      const cronHandler =
        bindings.cronHandler ??
        createCronHandler(
          logger,
          undefined,
          undefined,
          bindings.archive
            ? {
                projects: bindings.store.projects,
                queue: bindings.queue.producer,
              }
            : undefined,
          {
            store: bindings.store,
            blobs: bindings.blob,
            archived: !!bindings.archive,
            housekeeping:
              bindings.archive && archival
                ? {
                    store: bindings.store,
                    blobs: bindings.blob,
                    archive: bindings.archive,
                    worker: archival,
                    ...(cfg.archiveRetentionDays
                      ? { archiveRetentionDays: cfg.archiveRetentionDays }
                      : {}),
                    // TODO(M4l): snapshotExpiryDays once the engine has a verified expiry path.
                  }
                : undefined,
          },
        );
      const scheduled = jobs.filter(
        (job) => bindings.cronHandler || job.name !== "erasure-worker",
      );
      const running_ = new Set<string>();
      const runJob = (name: string, at: Date) => {
        // A job still running from the previous tick is skipped (the worker is lease-fenced anyway).
        if (running_.has(name)) return;
        running_.add(name);
        void Promise.resolve()
          .then(() => cronHandler(name, toTimestamp(at)))
          .catch((error) =>
            logger.error("Cron failed", { job: name, error: String(error) }),
          )
          .finally(() => running_.delete(name));
      };
      const intervals = scheduled.flatMap((job) => {
        const seconds = (
          cfg.cronIntervalSec as Record<string, number> | undefined
        )?.[job.name];
        return seconds
          ? [setInterval(() => runJob(job.name, new Date()), seconds * 1000)]
          : [];
      });
      for (const interval of intervals) interval.unref();
      const scheduleJobs = scheduled.filter(
        (job) =>
          !(cfg.cronIntervalSec as Record<string, number> | undefined)?.[
            job.name
          ],
      );
      let minute = -1;
      const timer = setInterval(() => {
        const now = new Date();
        const current = Math.floor(now.valueOf() / 60000);
        if (current === minute) return;
        minute = current;
        for (const job of scheduleJobs)
          if (cronMatches(job.schedule, now)) runJob(job.name, now);
      }, 1000);
      let closePromise: Promise<void> | undefined;
      const stop = () => {
        if (!closePromise)
          closePromise = (async () => {
            clearInterval(timer);
            for (const interval of intervals) clearInterval(interval);
            clearInterval(cleanupTimer);
            const deadline = Date.now() + 5000;
            const force = setTimeout(() => {
              if ("closeAllConnections" in server) server.closeAllConnections();
            }, 5000);
            let closeError: unknown;
            try {
              await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              );
            } catch (error) {
              closeError = error;
            } finally {
              clearTimeout(force);
            }
            try {
              while (
                bindings.queue.idle &&
                !(await bindings.queue.idle()) &&
                Date.now() < deadline
              )
                await new Promise<void>((resolve) => setTimeout(resolve, 10));
            } finally {
              abort.abort();
            }
            let drainTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                running,
                new Promise<void>((resolve) => {
                  drainTimer = setTimeout(
                    resolve,
                    Math.max(0, deadline - Date.now()),
                  );
                }),
              ]);
            } finally {
              if (drainTimer) clearTimeout(drainTimer);
            }
            if (closeError) throw closeError;
          })();
        return closePromise;
      };
      closeCurrent = stop;
      const address = server.address();
      if (!address || typeof address === "string") {
        await stop();
        throw new Error("Unexpected server address");
      }
      return {
        host: address.address,
        port: address.port,
        publicUrl: cfg.publicUrl,
        close: stop,
      };
    },
  };
}
