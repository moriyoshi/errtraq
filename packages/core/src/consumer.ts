import { CONSUMER_MAX_MISSING_ATTEMPTS } from "./consumer-policy.js";
import type { EventId, ProjectId, Timestamp } from "./domain.js";
import { isProjectId, isTimestamp } from "./domain.js";
import {
  InvalidEnvelopeError,
  parseEnvelope,
  parseEventPayload,
} from "./envelope.js";
import type { ClaimCheck } from "./ingest.js";
import { redactLogText } from "./log-redaction.js";
import { normalizeEvent, normalizeEventId } from "./normalize.js";
import type {
  ActiveStore,
  BatchHandler,
  BlobStore,
  KV,
  Logger,
  Queue,
} from "./ports.js";
import { type RateRejectionConfig, RateRejector } from "./rate-rejection.js";

export interface ConsumerOptions {
  store?: ActiveStore;
  recordMode?: "direct" | "grouped";
  queue?: Queue;
  blobs: BlobStore;
  kv?: KV;
  logger: Logger;
  overflowBytes?: number;
  maxEnvelopeBytes?: number;
  shouldSuppress?: (
    event: import("./domain.js").StoredEvent,
  ) => boolean | Promise<boolean>;
  maxMissingAttempts?: number;
  rateRejection?: RateRejectionConfig;
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
interface PendingEvent {
  item: { payload: Uint8Array };
  eventId: EventId;
  normalized: Awaited<ReturnType<typeof normalizeEvent>>;
}
/** Process each claim independently; only malformed data is acknowledged as poison. */
export class ConsumerService {
  private readonly overflowBytes: number;
  private readonly maxEnvelopeBytes: number;
  private readonly rejector?: RateRejector;
  constructor(private readonly options: ConsumerOptions) {
    if (options.recordMode === "grouped" ? !options.queue : !options.store)
      throw new Error("Missing consumer adapter for record mode");
    const rate = options.rateRejection;
    if (
      rate?.issueRateLimit ||
      (options.recordMode !== "grouped" && rate?.newIssueCap)
    ) {
      if (!options.kv) throw new Error("Rate rejection requires KV");
      this.rejector = new RateRejector({
        kv: options.kv,
        config: rate,
        logger: options.logger,
      });
    }
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
  private async admit(
    pending: PendingEvent[],
    rejector: RateRejector,
  ): Promise<PendingEvent[]> {
    if (pending.length === 0) return pending;
    const candidates = pending.map(({ normalized }) => normalized.occurrence);
    try {
      const allowed = await rejector.admitIssueEvents(candidates);
      if (
        rejector.newIssueCapEnabled &&
        this.options.recordMode !== "grouped"
      ) {
        const store = this.options.store;
        if (!store) throw new Error("Missing consumer store");
        const states = new Map<
          string,
          { exists: boolean; denied: Set<number> }
        >();
        const windowSec = this.options.rateRejection?.newIssueCap?.windowSec;
        if (!windowSec) throw new Error("Missing new-issue cap");
        for (let i = 0; i < pending.length; i++) {
          const candidate = candidates[i];
          if (!candidate || !allowed[i]) continue;
          const key = JSON.stringify([candidate.projectId, candidate.issueId]);
          let state = states.get(key);
          if (!state) {
            state = {
              exists: !!(await store.issues.get(
                candidate.projectId,
                candidate.issueId,
              )),
              denied: new Set<number>(),
            };
            states.set(key, state);
          }
          if (state.exists) continue;
          const bucket = Math.floor(
            Date.parse(candidate.receivedAt) / (windowSec * 1000),
          );
          if (!state.denied.has(bucket)) {
            const [accepted] = await rejector.admitNewIssues([candidate]);
            if (accepted) state.exists = true;
            else state.denied.add(bucket);
          }
          if (!state.exists) allowed[i] = false;
        }
      }
      await rejector.recordDropped(candidates.filter((_, i) => !allowed[i]));
      return pending.filter((_, i) => allowed[i]);
    } catch {
      // Do not expose provider exception text or names through the delivery log.
      throw new Error("Rate rejection failed");
    }
  }
  handle: BatchHandler = async (batch) => {
    const scope = this.rejector?.batch();
    try {
      return await this.handleBatch(batch, scope?.rejector, scope?.hasFailures);
    } finally {
      scope?.flush();
    }
  };
  private async handleBatch(
    batch: Parameters<BatchHandler>[0],
    rejector?: RateRejector,
    hasKvFailures?: () => boolean,
  ) {
    const results: Awaited<ReturnType<BatchHandler>> = [];
    const prepared: {
      resultIndex: number;
      deliveryId: string;
      pending: PendingEvent[];
      finish: (events: PendingEvent[]) => Promise<void>;
    }[] = [];
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
        const body = await this.options.blobs.get(claim.blobKey);
        if (!body) {
          if (
            typeof delivery.message.body === "object" &&
            delivery.message.body !== null &&
            "recovered" in delivery.message.body &&
            delivery.message.body.recovered === true
          ) {
            results.push({ deliveryId: delivery.id, action: "ack" });
            continue;
          }
          if (
            delivery.attempt >=
            (this.options.maxMissingAttempts ?? CONSUMER_MAX_MISSING_ATTEMPTS)
          ) {
            this.options.logger.error("Staged envelope is missing", {
              deliveryId: delivery.id,
              attempt: delivery.attempt,
            });
            results.push({ deliveryId: delivery.id, action: "ack" });
          } else results.push({ deliveryId: delivery.id, action: "retry" });
          continue;
        }
        const envelope = parseEnvelope(
          await readBounded(body, this.maxEnvelopeBytes + 256),
        );
        let dropped = 0;
        let eventIndex = 0;
        const pending: PendingEvent[] = [];
        const processEvents = async (events: PendingEvent[]) => {
          for (const { item, eventId, normalized } of events) {
            let overflowKey: string | undefined;
            if (item.payload.byteLength > this.overflowBytes) {
              overflowKey = `payloads/${claim.projectId}/${eventId}`;
              if (this.options.recordMode === "grouped") {
                const digest = Array.from(
                  new Uint8Array(
                    await crypto.subtle.digest(
                      "SHA-256",
                      new Uint8Array(item.payload),
                    ),
                  ),
                  (b) => b.toString(16).padStart(2, "0"),
                ).join("");
                overflowKey += `/${digest}`;
              }
              await this.options.blobs.put(overflowKey, item.payload, {
                size: item.payload.length,
                contentType: "application/json",
              });
              normalized.event.payload = {};
              normalized.event.payloadBlobKey = overflowKey;
            }
            if (this.options.recordMode === "grouped") {
              const queue = this.options.queue;
              if (!queue) throw new Error("Missing record queue");
              const record: unknown = JSON.parse(
                JSON.stringify({
                  version: 1,
                  occurrence: normalized.occurrence,
                  event: normalized.event,
                }),
              );
              let message = {
                key: eventId,
                groupKey: normalized.event.issueId,
                body: record as unknown,
              };
              const encode = (value: unknown) =>
                new TextEncoder().encode(
                  JSON.stringify(value)
                    .replaceAll("\ufffe", "\\ufffe")
                    .replaceAll("\uffff", "\\uffff"),
                );
              if (
                encode({ topic: "record", message }).length >
                queue.capabilities.maxBytes
              ) {
                const bytes = encode(record);
                if (bytes.length > 8 * 1024 * 1024)
                  throw new Error("Normalized record exceeds limit");
                const digest = Array.from(
                  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
                  (b) => b.toString(16).padStart(2, "0"),
                ).join("");
                const blobKey = `payloads/records/${claim.projectId}/${eventId}/${digest}`;
                await this.options.blobs.put(blobKey, bytes, {
                  size: bytes.length,
                  contentType: "application/json",
                });
                message = {
                  key: eventId,
                  groupKey: normalized.event.issueId,
                  body: { version: 1, blobKey },
                };
              }
              await queue.producer.send("record", [message]);
            } else {
              const store = this.options.store;
              if (!store) throw new Error("Missing consumer store");
              await store.recordEvent(normalized.occurrence, normalized.event);
            }
          }
        };
        for (const item of envelope.items) {
          if (item.headers.type !== "event") {
            dropped++;
            continue;
          }
          const payload = parseEventPayload(item.payload);
          const fallbackBytes = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`${delivery.message.key}:${eventIndex}`),
          );
          const fallback = Array.from(
            new Uint8Array(fallbackBytes).slice(0, 16),
            (x) => x.toString(16).padStart(2, "0"),
          ).join("") as EventId;
          const eventId =
            normalizeEventId(payload.event_id) ??
            (eventIndex === 0
              ? (normalizeEventId(envelope.headers.event_id) ??
                normalizeEventId(delivery.message.key))
              : null) ??
            fallback;
          eventIndex++;
          const normalized = await normalizeEvent(
            claim.projectId,
            eventId as EventId,
            claim.receivedAt,
            payload,
          );
          // TODO(M4): consult erasure suppression records before storing queued events.
          if (await this.options.shouldSuppress?.(normalized.event)) continue;
          if (
            this.options.recordMode !== "grouped" &&
            (await this.options.store?.events.get(claim.projectId, eventId))
          )
            continue;
          const event = { item, eventId, normalized };
          if (this.rejector) pending.push(event);
          else await processEvents([event]);
        }
        if (this.rejector) {
          const resultIndex = results.length;
          results.push({ deliveryId: delivery.id, action: "retry" });
          prepared.push({
            resultIndex,
            deliveryId: delivery.id,
            pending,
            finish: async (events) => {
              await processEvents(events);
              if (dropped)
                this.options.logger.info("Dropped unsupported envelope items", {
                  count: dropped,
                });
              await this.options.blobs.delete(claim.blobKey);
            },
          });
        } else {
          if (dropped)
            this.options.logger.info("Dropped unsupported envelope items", {
              count: dropped,
            });
          await this.options.blobs.delete(claim.blobKey);
          results.push({ deliveryId: delivery.id, action: "ack" });
        }
      } catch (error) {
        if (error instanceof InvalidEnvelopeError) {
          this.options.logger.error("Dropping invalid envelope", {
            deliveryId: delivery.id,
            error: redactLogText(error.message),
          });
          try {
            await this.options.blobs.delete(claim.blobKey);
            results.push({ deliveryId: delivery.id, action: "ack" });
          } catch {
            results.push({ deliveryId: delivery.id, action: "retry" });
          }
        } else {
          this.options.logger.error("Ingest delivery failed", {
            deliveryId: delivery.id,
            error: redactLogText(String(error)),
          });
          results.push({ deliveryId: delivery.id, action: "retry" });
        }
      }
    }
    if (rejector && prepared.length) {
      let accepted: Set<PendingEvent>;
      try {
        accepted = new Set(
          await this.admit(
            prepared.flatMap((item) => item.pending),
            rejector,
          ),
        );
      } catch {
        if (!hasKvFailures?.())
          this.options.logger.error("Rate rejection failed", {
            deliveries: prepared.length,
          });
        return results;
      }
      for (const item of prepared) {
        try {
          await item.finish(
            item.pending.filter((event) => accepted.has(event)),
          );
          results[item.resultIndex] = {
            deliveryId: item.deliveryId,
            action: "ack",
          };
        } catch (error) {
          this.options.logger.error("Ingest delivery failed", {
            deliveryId: item.deliveryId,
            error: redactLogText(String(error)),
          });
        }
      }
    }
    return results;
  }
}
