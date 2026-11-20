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
  QueueProducer,
} from "./ports.js";

export interface IngestOptions {
  store: ActiveStore;
  blobs: BlobStore;
  queue: QueueProducer;
  kv: KV;
  clock: Clock;
  maxBytes?: number;
  rateLimit?: number;
  rateWindowSec?: number;
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
/** Authenticate and stage a bounded raw envelope before publishing its claim check. */
export class IngestService {
  readonly maxBytes: number;
  private readonly rateLimit: number;
  private readonly rateWindowSec: number;
  constructor(private readonly options: IngestOptions) {
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.rateLimit = options.rateLimit ?? 60;
    this.rateWindowSec = options.rateWindowSec ?? 60;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      !Number.isSafeInteger(this.rateLimit) ||
      this.rateLimit < 1 ||
      !Number.isSafeInteger(this.rateWindowSec) ||
      this.rateWindowSec < 1
    )
      throw new RangeError("Invalid ingest limits");
  }
  async accept(request: IngestRequest): Promise<{ id: EventId }> {
    if (!isProjectId(request.projectId))
      throw new IngestError(400, "Invalid project ID");
    if (!request.key) throw new IngestError(401, "Missing Sentry key");
    const key = await this.options.store.projects.getKey(request.key);
    if (!key || key.revokedAt || key.projectId !== request.projectId)
      throw new IngestError(403, "Invalid Sentry key");
    if (request.body.byteLength > this.maxBytes)
      throw new IngestError(413, "Envelope too large");
    const receivedAt = this.options.clock.now();
    const bucket = Math.floor(
      Date.parse(receivedAt) / (this.rateWindowSec * 1000),
    );
    const count = await this.options.kv.increment(
      `ingest-rate:${key.id}:${bucket}`,
      1,
      { ttlSec: this.rateWindowSec * 2 },
    );
    if (count > this.rateLimit) {
      const seconds = Math.max(
        1,
        Math.ceil(
          ((bucket + 1) * this.rateWindowSec * 1000 - Date.parse(receivedAt)) /
            1000,
        ),
      );
      throw new IngestError(429, "Rate limit exceeded", seconds);
    }
    let raw = request.body;
    let id: EventId | null = null;
    try {
      if (request.legacy) {
        const payload = parseEventPayload(raw);
        if (
          payload.event_id !== undefined &&
          !normalizeEventId(payload.event_id)
        )
          throw new InvalidEnvelopeError("Invalid event ID");
        id = normalizeEventId(payload.event_id);
      } else {
        const envelope = parseEnvelope(raw);
        if (
          envelope.headers.event_id !== undefined &&
          !normalizeEventId(envelope.headers.event_id)
        )
          throw new InvalidEnvelopeError("Invalid event ID");
        id = normalizeEventId(envelope.headers.event_id);
        for (const item of envelope.items) {
          if (item.headers.type !== "event") continue;
          const payload = parseEventPayload(item.payload);
          const payloadId = normalizeEventId(payload.event_id);
          if (payload.event_id !== undefined && !payloadId)
            throw new InvalidEnvelopeError("Invalid event ID");
          if (id && payloadId && id !== payloadId)
            throw new InvalidEnvelopeError("Envelope and event IDs differ");
          id ??= payloadId;
        }
      }
    } catch (error) {
      if (error instanceof InvalidEnvelopeError)
        throw new IngestError(400, error.message);
      throw error;
    }
    id ??= crypto.randomUUID().replaceAll("-", "") as EventId;
    if (request.legacy) raw = wrapStorePayload(raw, id);
    const blobKey = `envelopes/${request.projectId}/${crypto.randomUUID()}`;
    await this.options.blobs.put(blobKey, raw, {
      size: raw.byteLength,
      contentType: "application/x-sentry-envelope",
    });
    const claim: ClaimCheck = {
      projectId: request.projectId,
      blobKey,
      receivedAt,
    };
    // If publication fails ambiguously the staged blob must remain available for a possible delivery.
    await this.options.queue.send("ingest", [{ key: id, body: claim }]);
    return { id };
  }
}
