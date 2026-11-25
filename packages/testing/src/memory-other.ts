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
} from "@moriyoshi/errtraq-core";
import {
  dayOf,
  decodeStagedBatch,
  InvalidCounterError,
  validateBlobKey,
  validateQueueBody,
} from "@moriyoshi/errtraq-core";
import {
  bytes,
  compareUtf8,
  copy,
  eventPage,
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
    validateBlobKey(key);
    const data = await bytes(body);
    if (metadata?.size !== undefined && metadata.size !== data.length)
      throw new Error("Size mismatch");
    this.objects.set(key, { data, contentType: metadata?.contentType });
  }
  async get(
    key: string,
    options?: { range?: { offset: number; length?: number } },
  ) {
    validateBlobKey(key);
    const obj = this.objects.get(key);
    if (!obj) return null;
    const range = options?.range;
    if (!range) return stream(obj.data);
    if (range.offset < 0 || (range.length !== undefined && range.length < 0))
      throw new RangeError("Invalid range");
    return stream(
      obj.data.slice(
        range.offset,
        range.length === undefined ? undefined : range.offset + range.length,
      ),
    );
  }
  async head(key: string) {
    validateBlobKey(key);
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
    cursor?: import("@moriyoshi/errtraq-core").Cursor,
    limit?: number,
  ) {
    return page(
      [...this.objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort(compareUtf8),
      cursor,
      limit,
      (key) => [key],
      JSON.stringify(["blob", prefix]),
      (a, b) => compareUtf8(String(a[0]), String(b[0])),
    );
  }
  async delete(key: string): Promise<void> {
    validateBlobKey(key);
    this.objects.delete(key);
  }
}

export class MemoryKV implements KV {
  private values = new Map<string, { value: string; expires?: number }>();
  constructor(private clock: Clock = new FakeClock()) {}
  async increment(
    key: string,
    by: number,
    options?: { ttlSec?: number },
  ): Promise<number> {
    const row = this.values.get(key);
    const now = Date.parse(this.clock.now());
    const current =
      row && (row.expires === undefined || row.expires > now) ? row : undefined;
    if (
      current &&
      (!/^-?\d+$/.test(current.value) ||
        !Number.isSafeInteger(Number(current.value)))
    )
      throw new InvalidCounterError("Counter must be decimal");
    if (!Number.isSafeInteger(by))
      throw new InvalidCounterError("Increment must be a safe integer");
    const result = Number(current?.value ?? "0") + by;
    if (!Number.isSafeInteger(result))
      throw new InvalidCounterError("Value must be an integer");
    this.values.set(key, {
      value: String(result),
      ...(current?.expires !== undefined
        ? { expires: current.expires }
        : !current && options?.ttlSec !== undefined
          ? { expires: now + options.ttlSec * 1000 }
          : {}),
    });
    return result;
  }
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
    grouping: "per-key-serial" as const,
  };
  private readonly activeGroups = new Set<string>();
  private group(delivery: Delivery): string | undefined {
    return delivery.message.groupKey ? delivery.message.groupKey : undefined;
  }
  private eligible(row: Queued): boolean {
    const group = this.group(row.delivery);
    return (
      row.available <= Date.parse(this.clock.now()) &&
      (!group ||
        (!this.activeGroups.has(group) &&
          !this.rows.some(
            (earlier) =>
              this.group(earlier.delivery) === group &&
              Number(earlier.delivery.id) < Number(row.delivery.id),
          )))
    );
  }
  private rows: Queued[] = [];
  private nextId = 0;
  constructor(private clock: Clock = new FakeClock()) {}
  producer: Queue["producer"] = {
    send: async (topic, messages, options) => {
      const delay = options?.delaySec ?? 0;
      if (!Number.isFinite(delay) || delay < 0)
        throw new RangeError("Invalid queue delay");
      for (const message of messages) {
        validateQueueBody(message.body);
        if (
          message.groupKey !== undefined &&
          (typeof message.groupKey !== "string" || !message.groupKey)
        )
          throw new TypeError("Invalid group key");
      }
      const copies = messages.map((message) => copy(message));
      for (const message of copies)
        if (
          new TextEncoder().encode(JSON.stringify(message)).length >
          this.capabilities.maxBytes
        )
          throw new Error("Message too large");
      for (const message of copies)
        this.rows.push({
          delivery: { id: String(++this.nextId), topic, message, attempt: 1 },
          available: Date.parse(this.clock.now()) + delay * 1000,
        });
    },
  };
  push: NonNullable<Queue["push"]> = {
    handle: async (event, handler) => {
      const deliveries = event as Delivery[];
      const ids = new Set(deliveries.map((delivery) => delivery.id));
      const items = this.rows.filter((row) => ids.has(row.delivery.id));
      const groups = items
        .map((item) => this.group(item.delivery))
        .filter((group): group is string => !!group);
      if (groups.some((group) => this.activeGroups.has(group)))
        throw new Error("Group already in flight");
      for (const group of groups) this.activeGroups.add(group);
      this.rows = this.rows.filter((row) => !ids.has(row.delivery.id));
      let result: BatchResult = [];
      try {
        result = await handler(copy(deliveries));
      } catch {
        /* Retry failed invocations. */
      }
      for (const group of groups) this.activeGroups.delete(group);
      for (const item of items) {
        const action = result.find((r) => r.deliveryId === item.delivery.id);
        if (action?.action === "ack") continue;
        item.delivery.attempt++;
        item.available =
          Date.parse(this.clock.now()) +
          (action?.action === "retry" ? (action.delaySec ?? 0) : 0) * 1000;
        this.rows.push(item);
      }
      return result;
    },
  };

  /** Simulates platform selection of one event and invokes the push source. */
  async deliverPush(handler: BatchHandler): Promise<void> {
    const item = this.rows.find((row) => this.eligible(row));
    if (item) await this.push.handle([item.delivery], handler);
  }

  pull: NonNullable<Queue["pull"]> = {
    run: async (handler, signal) => {
      while (!signal.aborted) {
        const index = this.rows.findIndex((item) => this.eligible(item));
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
        const group = this.group(item.delivery);
        if (group) this.activeGroups.add(group);
        try {
          const result = await handler([copy(item.delivery)]);
          const action = result.find((r) => r.deliveryId === item.delivery.id);
          if (action?.action === "ack") continue;
          item.available =
            Date.parse(this.clock.now()) +
            (action?.action === "retry" ? (action.delaySec ?? 0) : 0) * 1000;
        } catch {
          item.available = Date.parse(this.clock.now());
        } finally {
          if (group) this.activeGroups.delete(group);
        }
        item.delivery.attempt++;
        this.rows.push(item);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

/** The fake reads staged batches through the shared Parquet codec, like the real engines do. */
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
  private pending = new Map<
    string,
    Promise<{ snapshotId: string; rowCount: number }>
  >();
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
    const inflight = this.pending.get(batch.batchId);
    if (inflight) return inflight;
    const write = (async () => {
      const body = await this.blobs.get(batch.stagedKey);
      if (!body) throw new Error("Missing staged batch");
      const { rows } = await decodeStagedBatch(await bytes(body));
      const snapshotId = `snapshot-${++this.snapshots}`;
      this.batches.set(batch.batchId, {
        snapshotId,
        rowCount: rows.length,
        rows: copy(rows),
        file: batch.stagedKey,
      });
      return { snapshotId, rowCount: rows.length };
    })();
    this.pending.set(batch.batchId, write);
    try {
      return await write;
    } finally {
      this.pending.delete(batch.batchId);
    }
  }
  /** True when a row of the batch falls in the inclusive day range, like the partition-pruned probe. */
  async hasBatch(
    batchId: string,
    range: Parameters<ArchiveStore["hasBatch"]>[1],
  ) {
    const batch = this.batches.get(batchId);
    return (
      !!batch &&
      batch.rows.some((row) => {
        const rowDay = dayOf(row.receivedAt);
        return rowDay >= range[0] && rowDay <= range[1];
      })
    );
  }
  async query(query: Parameters<ArchiveStore["query"]>[0]) {
    return eventPage(
      this.rows().filter(
        (e) =>
          e.projectId === query.projectId &&
          (!query.issueId || e.issueId === query.issueId) &&
          (!query.from || e.receivedAt >= query.from) &&
          (!query.to || e.receivedAt < query.to),
      ),
      query,
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
