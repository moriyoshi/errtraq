import type {
  ArchiveStore,
  BatchHandler,
  BatchResult,
  BlobStore,
  Clock,
  Delivery,
  ErasureId,
  KV,
  Queue,
  StoredEvent,
} from "@errtraq/core";
import {
  bytes,
  copy,
  eventOrder,
  FakeClock,
  matchesSubject,
  page,
  stream,
} from "./shared.js";

export class MemoryBlobStore implements BlobStore {
  private objects = new Map<
    string,
    { data: Uint8Array; contentType?: string }
  >();
  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    metadata?: { contentType?: string; size?: number },
  ): Promise<void> {
    const data = await bytes(body);
    if (metadata?.size !== undefined && metadata.size !== data.length)
      throw new Error("Size mismatch");
    this.objects.set(key, { data, contentType: metadata?.contentType });
  }
  async get(key: string) {
    const obj = this.objects.get(key);
    return obj ? stream(obj.data) : null;
  }
  async head(key: string) {
    const obj = this.objects.get(key);
    return obj
      ? {
          size: obj.data.length,
          ...(obj.contentType === undefined
            ? {}
            : { contentType: obj.contentType }),
        }
      : null;
  }
  async list(
    prefix: string,
    cursor?: import("@errtraq/core").Cursor,
    limit?: number,
  ) {
    return page(
      [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
      cursor,
      limit,
    );
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export class MemoryKV implements KV {
  private values = new Map<string, { value: string; expires?: number }>();
  constructor(private clock: Clock = new FakeClock()) {}
  async get(key: string) {
    const row = this.values.get(key);
    if (!row) return null;
    if (
      row.expires !== undefined &&
      Date.parse(this.clock.now()) >= row.expires
    ) {
      this.values.delete(key);
      return null;
    }
    return row.value;
  }
  async put(key: string, value: string, options?: { ttlSec?: number }) {
    this.values.set(key, {
      value,
      ...(options?.ttlSec === undefined
        ? {}
        : { expires: Date.parse(this.clock.now()) + options.ttlSec * 1000 }),
    });
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

interface Queued {
  delivery: Delivery;
  available: number;
}
export class MemoryQueue implements Queue {
  readonly capabilities = {
    delivery: "both" as const,
    maxBytes: 256000,
    delay: true,
    dlq: false,
  };
  private rows: Queued[] = [];
  private nextId = 0;
  constructor(private clock: Clock = new FakeClock()) {}
  producer: Queue["producer"] = {
    send: async (topic, messages, options) => {
      for (const message of messages)
        this.rows.push({
          delivery: {
            id: String(++this.nextId),
            topic,
            message: copy(message),
            attempt: 1,
          },
          available:
            Date.parse(this.clock.now()) + (options?.delaySec ?? 0) * 1000,
        });
    },
  };
  push: NonNullable<Queue["push"]> = {
    toBatch: (event) => copy(event as Delivery[]),
    toResponse: (result) => copy(result),
  };

  /** Simulates a platform delivering one message to the push source. */
  async deliverPush(handler: BatchHandler): Promise<void> {
    const index = this.rows.findIndex(
      (item) => item.available <= Date.parse(this.clock.now()),
    );
    if (index < 0) return;
    const [item] = this.rows.splice(index, 1);
    if (!item) return;
    let result: BatchResult = [];
    try {
      result = this.push.toResponse(
        await handler(this.push.toBatch([item.delivery])),
      ) as BatchResult;
    } catch {
      /* Redeliver failed invocations. */
    }
    const action = result.find((r) => r.deliveryId === item.delivery.id);
    if (action?.action === "ack") return;
    item.delivery.attempt++;
    item.available =
      Date.parse(this.clock.now()) +
      (action?.action === "retry" ? (action.delaySec ?? 0) : 0) * 1000;
    this.rows.push(item);
  }

  pull: NonNullable<Queue["pull"]> = {
    run: async (handler, signal) => {
      while (!signal.aborted) {
        const index = this.rows.findIndex(
          (item) => item.available <= Date.parse(this.clock.now()),
        );
        if (index < 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, 5);
            function done() {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            }
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
          continue;
        }
        const [item] = this.rows.splice(index, 1);
        if (!item) continue;
        try {
          const result = await handler([copy(item.delivery)]);
          const action = result.find((r) => r.deliveryId === item.delivery.id);
          if (action?.action === "ack") continue;
          item.available =
            Date.parse(this.clock.now()) +
            (action?.action === "retry" ? (action.delaySec ?? 0) : 0) * 1000;
        } catch {
          item.available = Date.parse(this.clock.now());
        }
        item.delivery.attempt++;
        this.rows.push(item);
      }
    },
  };
}

/** The fake stages JSON arrays through a blob store; production archive adapters choose their own format. */
export class MemoryArchiveStore implements ArchiveStore {
  readonly capabilities = { rowDelete: "deletion-vector" as const };
  private batches = new Map<
    string,
    { snapshotId: string; rowCount: number; rows: StoredEvent[]; file: string }
  >();
  private erased = new Map<
    ErasureId,
    { files: string[]; rowsDeleted: number }
  >();
  private masked = new Set<string>();
  private snapshots = 0;
  constructor(readonly blobs: BlobStore = new MemoryBlobStore()) {}
  private rowKey(row: StoredEvent) {
    return JSON.stringify([row.projectId, row.eventId]);
  }
  private rows(): StoredEvent[] {
    return [...this.batches.values()]
      .flatMap((b) => b.rows)
      .filter((row) => !this.masked.has(this.rowKey(row)));
  }
  async append(batch: Parameters<ArchiveStore["append"]>[0]) {
    const previous = this.batches.get(batch.batchId);
    if (previous)
      return {
        snapshotId: previous.snapshotId,
        rowCount: previous.rowCount,
      };
    const body = await this.blobs.get(batch.stagedKey);
    if (!body) throw new Error("Missing staged batch");
    const rows = JSON.parse(
      new TextDecoder().decode(await bytes(body)),
    ) as StoredEvent[];
    const snapshotId = `snapshot-${++this.snapshots}`;
    this.batches.set(batch.batchId, {
      snapshotId,
      rowCount: rows.length,
      rows: copy(rows),
      file: batch.stagedKey,
    });
    return { snapshotId, rowCount: rows.length };
  }
  async hasBatch(
    batchId: string,
    _range: Parameters<ArchiveStore["hasBatch"]>[1],
  ) {
    return this.batches.has(batchId);
  }
  async query(query: Parameters<ArchiveStore["query"]>[0]) {
    return page(
      this.rows()
        .filter(
          (e) =>
            e.projectId === query.projectId &&
            (!query.issueId || e.issueId === query.issueId) &&
            (!query.from || e.receivedAt >= query.from) &&
            (!query.to || e.receivedAt < query.to),
        )
        .sort(eventOrder),
      query.cursor,
      query.limit,
    );
  }
  async getEvent(
    projectId: Parameters<ArchiveStore["getEvent"]>[0],
    eventId: Parameters<ArchiveStore["getEvent"]>[1],
  ) {
    return copy(
      this.rows().find(
        (e) => e.projectId === projectId && e.eventId === eventId,
      ) ?? null,
    );
  }
  async deleteWhere(request: Parameters<ArchiveStore["deleteWhere"]>[0]) {
    const previous = this.erased.get(request.erasureId);
    if (previous)
      return {
        snapshotId: previous.rowsDeleted ? `mask-${request.erasureId}` : null,
        ...copy(previous),
      };
    const files = new Set<string>();
    let rowsDeleted = 0;
    for (const batch of this.batches.values())
      for (const row of batch.rows)
        if (
          row.projectId === request.projectId &&
          !this.masked.has(this.rowKey(row)) &&
          matchesSubject(row, request.selector)
        ) {
          this.masked.add(this.rowKey(row));
          files.add(batch.file);
          rowsDeleted++;
        }
    const result = { files: [...files], rowsDeleted };
    this.erased.set(request.erasureId, result);
    return {
      snapshotId: rowsDeleted ? `mask-${request.erasureId}` : null,
      ...copy(result),
    };
  }
  async hardErase(request: Parameters<ArchiveStore["hardErase"]>[0]) {
    for (const batch of this.batches.values())
      if (request.files.includes(batch.file))
        batch.rows = batch.rows.filter(
          (row) => !this.masked.has(this.rowKey(row)),
        );
    return { snapshotId: `rewrite-${request.erasureId}` };
  }
  async expireSnapshots(
    _olderThan: Parameters<ArchiveStore["expireSnapshots"]>[0],
  ) {
    /* The fake retains no historical snapshots. */
  }
}
