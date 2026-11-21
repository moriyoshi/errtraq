import { isProjectId, isTimestamp } from "./domain.js";
import type {
  ActiveStore,
  BatchHandler,
  BlobStore,
  Delivery,
  Logger,
  RecordInput,
} from "./ports.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
class PoisonRecord extends Error {}

/** Consume normalized records in issue order. Delivery remains at-least-once. */
export class RecordHandler {
  constructor(
    private readonly options: {
      store: ActiveStore;
      blobs: BlobStore;
      logger: Logger;
    },
  ) {
    if (!options.store.capabilities.recordEvents || !options.store.recordEvents)
      throw new Error("Store does not support grouped recording");
  }
  private async decode(delivery: Delivery): Promise<RecordInput> {
    let value = object(delivery.message.body);
    if (value?.version !== 1) throw new PoisonRecord();
    if (typeof value.blobKey === "string") {
      if (!value.blobKey.startsWith("payloads/records/"))
        throw new PoisonRecord();
      const stream = await this.options.blobs.get(value.blobKey);
      if (!stream) throw new Error("Record claim unavailable");
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
            if (error instanceof PoisonRecord && item.attempt === 1)
              this.options.logger.error("Invalid record delivery", {
                deliveryId: item.id,
              });
            break;
          }
        }
        if (prefix.length) {
          try {
            const recordEvents = this.options.store.recordEvents;
            if (!recordEvents)
              throw new Error("Store does not support grouped recording");
            await recordEvents.call(this.options.store, prefix);
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
  };
}
