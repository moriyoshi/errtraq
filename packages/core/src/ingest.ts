import {
  type EventId,
  isProjectId,
  type ProjectId,
  type Timestamp,
} from "./domain.js";
import {
  InvalidEnvelopeError,
  parseEnvelope,
  parseEventPayload,
  wrapStorePayload,
} from "./envelope.js";
import { normalizeEventId } from "./normalize.js";
import type {
  ActiveStore,
  BlobStore,
  Clock,
  KV,
  Logger,
  QueueProducer,
} from "./ports.js";

export interface IngestOptions {
  store: ActiveStore;
  blobs: BlobStore;
  queue: QueueProducer;
  kv: KV;
  clock: Clock;
  maxBytes?: number;
  rateLimit?: number | null;
  rateWindowSec?: number;
  logger?: Logger;
}
export interface IngestRequest {
  projectId: string;
  key: string | null;
  body: Uint8Array;
  legacy?: boolean;
}
export interface ClaimCheck {
  projectId: ProjectId;
  blobKey: string;
  receivedAt: Timestamp;
}
export class IngestError extends Error {
  override name = "IngestError";
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}
/** Authenticate and stage a bounded raw envelope before publishing its claim check. Error events use a fixed-window rate limit; unsupported-only envelopes do not consume it. */
export class IngestService {
  readonly maxBytes: number;
  private readonly rateLimit: number | null;
  private readonly rateWindowSec: number;
  constructor(private readonly options: IngestOptions) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.rateLimit = options.rateLimit === undefined ? 60 : options.rateLimit;
    this.rateWindowSec = options.rateWindowSec ?? 60;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      (this.rateLimit !== null &&
        (!Number.isSafeInteger(this.rateLimit) || this.rateLimit < 1)) ||
      !Number.isSafeInteger(this.rateWindowSec) ||
      this.rateWindowSec < 1
    )
      throw new RangeError("Invalid ingest limits");
  }
  async authenticate(projectId: string, publicKey: string | null) {
    if (!isProjectId(projectId))
      throw new IngestError(400, "Invalid project ID");
    if (!publicKey) throw new IngestError(401, "Missing Sentry key");
    const key = await this.options.store.projects.getKey(publicKey);
    if (!key || key.revokedAt || key.projectId !== projectId)
      throw new IngestError(403, "Invalid Sentry key");
    return key;
  }
  async accept(request: IngestRequest): Promise<{ id: EventId }> {
    const key = await this.authenticate(request.projectId, request.key);
    if (request.body.byteLength > this.maxBytes)
      throw new IngestError(413, "Envelope too large");
    const receivedAt = this.options.clock.now();
    let raw = request.body;
    let id: EventId | null = null;
    let eventCount = request.legacy ? 1 : 0;
    const discarded: Record<string, number> = {};
    try {
      if (request.legacy) {
        const payload = parseEventPayload(raw);
        id = normalizeEventId(payload.event_id);
      } else {
        const envelope = parseEnvelope(raw);
        id = normalizeEventId(envelope.headers.event_id);
        for (const item of envelope.items) {
          if (item.headers.type !== "event") {
            const type = String(item.headers.type);
            discarded[type] = (discarded[type] ?? 0) + 1;
            continue;
          }
          eventCount++;
          const payload = parseEventPayload(item.payload);
          id ??= normalizeEventId(payload.event_id);
        }
      }
    } catch (error) {
      if (error instanceof InvalidEnvelopeError)
        throw new IngestError(400, error.message);
      throw error;
    }
    id ??= crypto.randomUUID().replaceAll("-", "") as EventId;
    if (Object.keys(discarded).length) {
      const sessionOnly =
        !eventCount &&
        Object.keys(discarded).every(
          (type) => type === "session" || type === "sessions",
        );
      if (this.options.logger)
        this.options.logger[sessionOnly ? "debug" : "info"](
          "Dropped unsupported envelope items",
          { types: discarded },
        );
      else if (!sessionOnly)
        console.info("Dropped unsupported envelope items", {
          types: discarded,
        });
    }
    if (!eventCount) return { id };
    if (this.rateLimit !== null) {
      const bucket = Math.floor(
        Date.parse(receivedAt) / (this.rateWindowSec * 1000),
      );
      const count = await this.options.kv.increment(
        `ingest-rate:${key.id}:${bucket}`,
        eventCount,
        { ttlSec: this.rateWindowSec * 2 },
      );
      if (count > this.rateLimit) {
        const seconds = Math.max(
          1,
          Math.ceil(
            ((bucket + 1) * this.rateWindowSec * 1000 -
              Date.parse(receivedAt)) /
              1000,
          ),
        );
        throw new IngestError(429, "Rate limit exceeded", seconds);
      }
    }

    if (request.legacy) raw = wrapStorePayload(raw, id);
    const blobKey = `envelopes/${request.projectId}/${encodeURIComponent(receivedAt)}/${id}/${crypto.randomUUID()}`;
    await this.options.blobs.put(blobKey, raw, {
      size: raw.byteLength,
      contentType: "application/x-sentry-envelope",
    });
    const claim: ClaimCheck = {
      projectId: request.projectId as ProjectId,
      blobKey,
      receivedAt,
    };
    try {
      await this.options.queue.send("ingest", [{ key: id, body: claim }]);
    } catch {
      try {
        await this.options.blobs.delete(blobKey);
      } catch {
        /* best effort */
      }
      throw new IngestError(503, "Queue unavailable", 1);
    }
    return { id };
  }
}
