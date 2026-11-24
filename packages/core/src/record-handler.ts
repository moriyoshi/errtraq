import { isProjectId, isTimestamp } from "./domain.js";
import type {
  ActiveStore,
  BatchHandler,
  BlobStore,
  Delivery,
  KV,
  Logger,
  RecordInput,
} from "./ports.js";
import { type RateRejectionConfig, RateRejector } from "./rate-rejection.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
class PoisonRecord extends Error {}
/** The claim check expired or was never written; no retry can recover it. */
class MissingClaim extends PoisonRecord {}

/** Consume normalized records in issue order. Delivery remains at-least-once. */
export class RecordHandler {
  private readonly rejector?: RateRejector;
  constructor(
    private readonly options: {
      store: ActiveStore;
      blobs: BlobStore;
      logger: Logger;
      kv?: KV;
      rateRejection?: RateRejectionConfig;
    },
  ) {
    if (!options.store.capabilities.recordEvents)
      throw new Error("Store does not support grouped recording");
    if (options.rateRejection?.newIssueCap) {
      if (!options.kv) throw new Error("New-issue cap requires KV");
      this.rejector = new RateRejector({
        kv: options.kv,
        config: options.rateRejection,
        logger: options.logger,
      });
    }
  }
  private async decode(delivery: Delivery): Promise<RecordInput> {
    let value = object(delivery.message.body);
    if (value?.version !== 1) throw new PoisonRecord();
    if (typeof value.blobKey === "string") {
      if (!value.blobKey.startsWith("payloads/records/"))
        throw new PoisonRecord();
      const stream = await this.options.blobs.get(value.blobKey);
      // A claim past its bucket lifecycle expiry (redrive after the horizon) is poison: the
      // queue redrives it to the DLQ at maxReceiveCount instead of it being treated as transient.
      if (!stream) throw new MissingClaim();
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new PoisonRecord();
          }
          chunks.push(part.value);
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
      try {
        value = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } catch {
        throw new PoisonRecord();
      }
    }
    const occurrence = object(value?.occurrence),
      event = object(value?.event);
    if (
      value?.version !== 1 ||
      !occurrence ||
      !event ||
      typeof occurrence.projectId !== "string" ||
      !isProjectId(occurrence.projectId) ||
      typeof occurrence.issueId !== "string" ||
      !occurrence.issueId ||
      occurrence.issueId !== delivery.message.groupKey ||
      typeof occurrence.eventId !== "string" ||
      occurrence.eventId !== delivery.message.key ||
      typeof occurrence.fingerprint !== "string" ||
      !occurrence.fingerprint ||
      typeof occurrence.receivedAt !== "string" ||
      !isTimestamp(occurrence.receivedAt) ||
      typeof occurrence.timestamp !== "string" ||
      !isTimestamp(occurrence.timestamp) ||
      typeof occurrence.title !== "string" ||
      typeof occurrence.culprit !== "string" ||
      typeof occurrence.type !== "string" ||
      !object(occurrence.metadata) ||
      !["fatal", "error", "warning", "info", "debug"].includes(
        String(occurrence.level),
      ) ||
      event.projectId !== occurrence.projectId ||
      event.issueId !== occurrence.issueId ||
      event.eventId !== occurrence.eventId ||
      event.receivedAt !== occurrence.receivedAt ||
      typeof event.timestamp !== "string" ||
      !isTimestamp(event.timestamp) ||
      !["fatal", "error", "warning", "info", "debug"].includes(
        String(event.level),
      ) ||
      !object(event.tags) ||
      !object(event.payload)
    )
      throw new PoisonRecord();
    return { occurrence, event } as unknown as RecordInput;
  }
  handle: BatchHandler = async (batch) => {
    const scope = this.rejector?.batch();
    try {
      return await this.handleBatch(batch, scope?.rejector);
    } finally {
      scope?.flush();
    }
  };
  private async handleBatch(
    batch: Parameters<BatchHandler>[0],
    rejector?: RateRejector,
  ) {
    const groups = new Map<string, Delivery[]>();
    for (const delivery of batch) {
      const key = delivery.message.groupKey ?? `invalid:${delivery.id}`;
      const group = groups.get(key) ?? [];
      group.push(delivery);
      groups.set(key, group);
    }
    const actions = new Map<string, "ack" | "retry">();
    for (const group of groups.values()) {
      let index = 0;
      let issueExists: boolean | undefined;
      let groupIdentity:
        | Pick<
            RecordInput["occurrence"],
            "projectId" | "issueId" | "fingerprint"
          >
        | undefined;
      const deniedWindows = new Set<number>();
      while (index < group.length) {
        const prefix: RecordInput[] = [];
        const items: Delivery[] = [];
        let failed: Delivery | undefined;
        let bytes = 0;
        while (index < group.length && prefix.length < 10) {
          const item = group[index];
          if (!item) break;
          try {
            if (item.topic !== "record" || !item.message.groupKey)
              throw new PoisonRecord();
            const value = await this.decode(item);
            const size = new TextEncoder().encode(JSON.stringify(value)).length;
            if (size > 3 * 1024 * 1024) throw new PoisonRecord();
            if (prefix.length && bytes + size > 3 * 1024 * 1024) break;
            bytes += size;
            prefix.push(value);
            items.push(item);
            index++;
          } catch (error) {
            failed = item;
            if (error instanceof MissingClaim)
              this.options.logger.error("Record claim blob is missing", {
                deliveryId: item.id,
                attempt: item.attempt,
              });
            else if (error instanceof PoisonRecord && item.attempt === 1)
              this.options.logger.error("Invalid record delivery", {
                deliveryId: item.id,
              });
            break;
          }
        }
        if (prefix.length) {
          try {
            let admitted = prefix;
            const cap = this.options.rateRejection?.newIssueCap;
            const first = prefix[0];
            // TODO(M4): the consumer must apply erasure suppression before any rate check or publish.
            if (rejector && cap && first) {
              groupIdentity ??= first.occurrence;
              if (
                prefix.some(
                  ({ occurrence }) =>
                    occurrence.projectId !== groupIdentity?.projectId ||
                    occurrence.issueId !== groupIdentity?.issueId ||
                    occurrence.fingerprint !== groupIdentity?.fingerprint,
                )
              )
                throw new Error("Record group identity mismatch");
              if (!issueExists)
                issueExists = !!(await this.options.store.issues.get(
                  first.occurrence.projectId,
                  first.occurrence.issueId,
                ));
              if (!issueExists) {
                const rejected: RecordInput[] = [];
                admitted = [];
                for (const input of prefix) {
                  const occurrence = input.occurrence;
                  const bucket = Math.floor(
                    Date.parse(occurrence.receivedAt) / (cap.windowSec * 1000),
                  );
                  if (!issueExists && !deniedWindows.has(bucket)) {
                    const [allowed] = await rejector.admitNewIssues([
                      occurrence,
                    ]);
                    if (allowed) issueExists = true;
                    else deniedWindows.add(bucket);
                  }
                  if (issueExists) admitted.push(input);
                  else rejected.push(input);
                }
                await rejector.recordDropped(
                  rejected.map((item) => item.occurrence),
                );
              }
            }
            if (admitted.length)
              await this.options.store.recordEvents(admitted);
            // TODO(M5): emit issue.created / issue.regressed through a durable notification outbox.
            for (const item of items) actions.set(item.id, "ack");
          } catch {
            for (const item of items) actions.set(item.id, "retry");
            for (const item of group.slice(index))
              actions.set(item.id, "retry");
            break;
          }
        }
        if (failed) {
          for (const item of group.slice(index)) actions.set(item.id, "retry");
          break;
        }
      }
    }
    return batch.map((item) => ({
      deliveryId: item.id,
      action: actions.get(item.id) ?? "retry",
    }));
  }
}
