import type { EventId, ProjectId, Timestamp } from "./domain.js";
import { isProjectId, isTimestamp } from "./domain.js";
import {
  InvalidEnvelopeError,
  parseEnvelope,
  parseEventPayload,
} from "./envelope.js";
import type { ClaimCheck } from "./ingest.js";
import { normalizeEvent, normalizeEventId } from "./normalize.js";
import type {
  ActiveStore,
  BatchHandler,
  BlobStore,
  KV,
  Logger,
} from "./ports.js";

export interface ConsumerOptions {
  store: ActiveStore;
  blobs: BlobStore;
  kv: KV;
  logger: Logger;
  overflowBytes?: number;
  maxEnvelopeBytes?: number;
}
async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new InvalidEnvelopeError("Envelope too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function claimCheck(value: unknown): ClaimCheck | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.projectId !== "string" ||
    !isProjectId(row.projectId) ||
    typeof row.blobKey !== "string" ||
    !row.blobKey ||
    typeof row.receivedAt !== "string" ||
    !isTimestamp(row.receivedAt)
  )
    return null;
  return {
    projectId: row.projectId as ProjectId,
    blobKey: row.blobKey,
    receivedAt: row.receivedAt as Timestamp,
  };
}
/** Process each claim independently; only malformed data is acknowledged as poison. */
export class ConsumerService {
  private readonly overflowBytes: number;
  private readonly maxEnvelopeBytes: number;
  constructor(private readonly options: ConsumerOptions) {
    this.overflowBytes = options.overflowBytes ?? 200000;
    this.maxEnvelopeBytes = options.maxEnvelopeBytes ?? 1024 * 1024;
    if (
      !Number.isSafeInteger(this.overflowBytes) ||
      this.overflowBytes < 0 ||
      !Number.isSafeInteger(this.maxEnvelopeBytes) ||
      this.maxEnvelopeBytes < 1
    )
      throw new RangeError("Invalid consumer limits");
  }
  handle: BatchHandler = async (batch) => {
    const results: Awaited<ReturnType<BatchHandler>> = [];
    for (const delivery of batch) {
      if (delivery.topic !== "ingest") {
        this.options.logger.warn("Unexpected queue topic", {
          topic: delivery.topic,
        });
        results.push({ deliveryId: delivery.id, action: "retry" });
        continue;
      }
      const claim = claimCheck(delivery.message.body);
      if (!claim || !normalizeEventId(delivery.message.key)) {
        this.options.logger.error("Invalid ingest claim", {
          deliveryId: delivery.id,
        });
        results.push({ deliveryId: delivery.id, action: "ack" });
        continue;
      }
      try {
        const marker = `ingest-complete:${claim.projectId}:${claim.blobKey}`;
        if (await this.options.kv.get(marker)) {
          await this.options.blobs.delete(claim.blobKey);
          results.push({ deliveryId: delivery.id, action: "ack" });
          continue;
        }
        const body = await this.options.blobs.get(claim.blobKey);
        if (!body) throw new Error("Staged envelope is missing");
        const envelope = parseEnvelope(
          await readBounded(body, this.maxEnvelopeBytes + 256),
        );
        let dropped = 0;
        for (const item of envelope.items) {
          if (item.headers.type !== "event") {
            dropped++;
            continue;
          }
          const payload = parseEventPayload(item.payload);
          const eventId = normalizeEventId(
            payload.event_id ??
              envelope.headers.event_id ??
              delivery.message.key,
          );
          if (!eventId) throw new InvalidEnvelopeError("Invalid event ID");
          const normalized = await normalizeEvent(
            claim.projectId,
            eventId as EventId,
            claim.receivedAt,
            payload,
          );
          let overflowKey: string | undefined;
          if (item.payload.byteLength > this.overflowBytes) {
            overflowKey = `payloads/${claim.projectId}/${eventId}/${crypto.randomUUID()}`;
            await this.options.blobs.put(overflowKey, item.payload, {
              size: item.payload.length,
              contentType: "application/json",
            });
            normalized.event.payload = {};
            normalized.event.payloadBlobKey = overflowKey;
          }
          const result = await this.options.store.recordEvent(
            normalized.occurrence,
            normalized.event,
          );
          if (!result.inserted && overflowKey)
            await this.options.blobs.delete(overflowKey);
        }
        if (dropped)
          this.options.logger.info("Dropped unsupported envelope items", {
            count: dropped,
          });
        // Keep completion markers until a queue-retention-aware cleanup exists; late redelivery must remain safe.
        await this.options.kv.put(marker, "1");
        await this.options.blobs.delete(claim.blobKey);
        results.push({ deliveryId: delivery.id, action: "ack" });
      } catch (error) {
        if (error instanceof InvalidEnvelopeError) {
          this.options.logger.error("Dropping invalid envelope", {
            deliveryId: delivery.id,
            error: error.message,
          });
          try {
            await this.options.kv.put(
              `ingest-complete:${claim.projectId}:${claim.blobKey}`,
              "1",
            );
            await this.options.blobs.delete(claim.blobKey);
            results.push({ deliveryId: delivery.id, action: "ack" });
          } catch {
            results.push({ deliveryId: delivery.id, action: "retry" });
          }
        } else {
          this.options.logger.error("Ingest delivery failed", {
            deliveryId: delivery.id,
            error: String(error),
          });
          results.push({ deliveryId: delivery.id, action: "retry" });
        }
      }
    }
    return results;
  };
}
