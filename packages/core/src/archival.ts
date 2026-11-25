import {
  ARCHIVE_PROJECT_TOPIC,
  type ArchiveProjectMessage,
} from "./archive-planner.js";
import {
  type BatchLimits,
  DEFAULT_BATCH_LIMITS,
  estimateEventBytes,
  summarizeBatch,
} from "./archive-rows.js";
import {
  type ArchiveState,
  type Cursor,
  isProjectId,
  type ProjectId,
  type StoredEvent,
  type Timestamp,
  toTimestamp,
} from "./domain.js";
import { UnsupportedQueryError, VersionConflictError } from "./errors.js";
import type {
  ActiveStore,
  ArchiveStore,
  BatchHandler,
  BlobStore,
  Clock,
  Logger,
  QueueProducer,
} from "./ports.js";
import { ownsOverflowBlob } from "./retention.js";

/**
 * The per-project archival worker: the six-step batch state machine of ARCHITECTURE "Archival job",
 * independent of the archive engine. Every state transition is a compare-and-set on `ArchiveState`
 * that doubles as lease fencing: a worker whose CAS fails lost the lease and stops without writing.
 */

const EPOCH = "1970-01-01T00:00:00.000Z" as Timestamp;
const DAY_MS = 86_400_000;
const SCAN_PAGE = 10_000;
/** Largest delete chunk every store adapter accepts (DynamoDB batch writes cap at 25). */
const DEFAULT_DELETE_CHUNK = 25;
/** The worker stops starting batches after this share of the invocation time budget. */
export const ARCHIVE_BUDGET_FRACTION = 0.6;
/** Lease expiry is this multiple of the invocation timeout (ARCHITECTURE: about 2x). */
export const ARCHIVE_LEASE_FACTOR = 2;
export const DEFAULT_ARCHIVE_INVOCATION_TIMEOUT_MS = 15 * 60 * 1000;

export class ArchivalError extends Error {
  override name = "ArchivalError";
}
/** Another holder won a CAS: this worker must stop without writing. */
export class ArchiveLeaseLostError extends Error {
  override name = "ArchiveLeaseLostError";
}

export interface ArchivalOptions {
  store: Pick<ActiveStore, "projects" | "events" | "meta">;
  /** Holds overflow payloads and the `archive-staging/` objects. */
  blobs: BlobStore;
  archive: ArchiveStore;
  queue: QueueProducer;
  logger: Pick<Logger, "info" | "warn" | "error">;
  clock: Clock;
  /** Invocation time budget; the lease lasts twice as long and batches stop at 60% of it. */
  invocationTimeoutMs?: number;
  batchLimits?: BatchLimits;
  deleteChunk?: number;
  /** Lease owner ids; must be unique per run (the default is a random UUID). */
  newOwner?: () => string;
}

/** A held lease. `state` always mirrors the last state this holder wrote. */
export interface ArchiveLease {
  owner: string;
  state: ArchiveState;
  /** Counter making each staged object key of this holder unique. */
  attempt: number;
}

export type ArchiveRunStatus =
  | "done" // nothing older than the cutoff remains
  | "continued" // budget used up; a continuation message was sent
  | "busy" // another holder has a live lease
  | "lost" // a CAS failed: another holder took over
  | "missing-project";

export interface ArchiveRunResult {
  status: ArchiveRunStatus;
  batches: number;
  rows: number;
  /** cutoff minus the oldest active receivedAt seen at the first scan, 0 when none (the health signal). */
  lagMs: number;
}

interface RunStats {
  batches: number;
  rows: number;
  oldest?: Timestamp;
}

/** Nonce-keyed manifests of overflow payload keys; orphans are swept by archive housekeeping. */
export const ARCHIVE_OVERFLOW_PREFIX = "archive-overflow/";
const overflowManifestKey = (batchId: string, owner: string, attempt: number) =>
  `${ARCHIVE_OVERFLOW_PREFIX}${encodeURIComponent(batchId)}-${encodeURIComponent(owner)}-${attempt}.json`;

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export class ArchiveWorker {
  private readonly timeoutMs: number;
  private readonly limits: BatchLimits;
  private readonly chunk: number;

  constructor(private readonly options: ArchivalOptions) {
    this.timeoutMs =
      options.invocationTimeoutMs ?? DEFAULT_ARCHIVE_INVOCATION_TIMEOUT_MS;
    this.limits = options.batchLimits ?? DEFAULT_BATCH_LIMITS;
    this.chunk = options.deleteChunk ?? DEFAULT_DELETE_CHUNK;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new RangeError("invocationTimeoutMs must be a positive integer");
    if (!Number.isSafeInteger(this.chunk) || this.chunk < 1)
      throw new RangeError("deleteChunk must be a positive integer");
  }

  private nowMs(): number {
    return Date.parse(this.options.clock.now());
  }
  private leaseUntil(): Timestamp {
    return toTimestamp(
      new Date(this.nowMs() + ARCHIVE_LEASE_FACTOR * this.timeoutMs),
    );
  }

  /** Queue handler for the `archive.project` topic (also used for continuations). */
  readonly handle: BatchHandler = async (batch) => {
    const results: Awaited<ReturnType<BatchHandler>> = [];
    for (const delivery of batch) {
      const body = delivery.message.body as Partial<ArchiveProjectMessage>;
      if (
        delivery.topic !== ARCHIVE_PROJECT_TOPIC ||
        !body ||
        typeof body.projectId !== "string" ||
        !isProjectId(body.projectId)
      ) {
        this.options.logger.error("Invalid archive message", {
          deliveryId: delivery.id,
        });
        results.push({ deliveryId: delivery.id, action: "ack" });
        continue;
      }
      try {
        await this.run(body.projectId);
        results.push({ deliveryId: delivery.id, action: "ack" });
      } catch (error) {
        this.options.logger.error("Archival run failed", {
          projectId: body.projectId,
          error: String(error),
        });
        results.push({ deliveryId: delivery.id, action: "retry" });
      }
    }
    return results;
  };

  /** One invocation for a project: acquire the lease, archive batches within the budget, release. */
  async run(projectId: ProjectId): Promise<ArchiveRunResult> {
    const { store, logger } = this.options;
    const stats: RunStats = { batches: 0, rows: 0 };
    const result = (status: ArchiveRunStatus, lagMs = 0): ArchiveRunResult => ({
      status,
      batches: stats.batches,
      rows: stats.rows,
      lagMs,
    });
    if (store.events.capabilities.deleteStrategy !== "explicit")
      // The TTL strategy is deferred past M4m (D14); it would need the persisted scan cursor.
      throw new UnsupportedQueryError(
        "Archival supports only the explicit delete strategy",
      );
    const project = await store.projects.get(projectId);
    if (!project) {
      logger.warn("Archival skipped an unknown project", { projectId });
      return result("missing-project");
    }
    const started = this.nowMs();
    // D12: retentionDays is the hot-tier age; archive housekeeping enforces archiveRetentionDays.
    const cutoff = toTimestamp(
      new Date(started - project.retentionDays * DAY_MS),
    );
    const lease = await this.acquire(projectId);
    if (!lease) return result("busy");
    let more = false;
    try {
      for (;;) {
        if (lease.state.batch) {
          // Resumed: found in state, not created by this loop.
          await this.drive(lease, undefined, stats);
          continue;
        }
        if (
          this.nowMs() - started >=
          ARCHIVE_BUDGET_FRACTION * this.timeoutMs
        ) {
          more = true;
          break;
        }
        const rows = await this.commitStart(lease, cutoff, stats);
        if (!rows) break;
        await this.drive(lease, rows, stats);
      }
      await this.release(lease);
    } catch (error) {
      if (error instanceof ArchiveLeaseLostError) {
        logger.warn("Archival lease lost", { projectId });
        return result("lost");
      }
      throw error;
    }
    const lagMs = stats.oldest
      ? Math.max(0, Date.parse(cutoff) - Date.parse(stats.oldest))
      : 0;
    logger.info("Archival run finished", {
      projectId,
      batches: stats.batches,
      rows: stats.rows,
      lagMs,
      continued: more,
    });
    if (more) {
      // Sent after the lease release so the continuation can take it at once. The key is the batch
      // counter, so a redelivered run of the same position produces the same message key.
      await this.options.queue.send(ARCHIVE_PROJECT_TOPIC, [
        {
          key: `archive-continue/${projectId}/${lease.state.seq}`,
          body: {
            projectId,
            continuation: true,
          } satisfies ArchiveProjectMessage,
        },
      ]);
      return result("continued", lagMs);
    }
    return result("done", lagMs);
  }

  /**
   * Take the lease by CAS (creating the state at version 0 when absent). Null when another holder's
   * lease is live or a concurrent CAS won.
   */
  async acquire(projectId: ProjectId): Promise<ArchiveLease | null> {
    const { meta } = this.options.store;
    const owner = this.options.newOwner?.() ?? crypto.randomUUID();
    const lease = { owner, until: this.leaseUntil() };
    const current = await meta.getArchiveState(projectId);
    if (current?.lease && current.lease.until > this.options.clock.now())
      return null;
    const next: ArchiveState = current
      ? { ...current, version: current.version + 1, lease }
      : { projectId, version: 0, archivedThrough: EPOCH, seq: 0, lease };
    try {
      await meta.compareAndSetArchiveState(
        projectId,
        current ? current.version : null,
        next,
      );
    } catch (error) {
      if (error instanceof VersionConflictError) return null;
      throw error;
    }
    return { owner, state: next, attempt: 0 };
  }

  /** CAS the next state; a version conflict means the lease was lost. Renews the lease. */
  private async advance(
    lease: ArchiveLease,
    change: (next: ArchiveState) => void,
    renew = true,
  ): Promise<void> {
    const previous = lease.state;
    const next: ArchiveState = structuredClone(previous);
    change(next);
    next.version = previous.version + 1;
    if (renew) next.lease = { owner: lease.owner, until: this.leaseUntil() };
    else delete next.lease;
    try {
      await this.options.store.meta.compareAndSetArchiveState(
        previous.projectId,
        previous.version,
        next,
      );
    } catch (error) {
      if (error instanceof VersionConflictError)
        throw new ArchiveLeaseLostError();
      throw error;
    }
    lease.state = next;
  }

  /** Release the lease (clears it with a CAS); housekeeping and erasure use it after their work. */
  async release(lease: ArchiveLease): Promise<void> {
    await this.advance(lease, () => {}, false);
  }

  /** Re-inline an overflow payload; the staged object must be self-contained. */
  private async inline(
    row: StoredEvent,
    overflowKeys: string[],
  ): Promise<StoredEvent> {
    const key = row.payloadBlobKey;
    if (!key) return row;
    if (!ownsOverflowBlob(row.projectId, key))
      throw new ArchivalError(
        `Unexpected overflow payload key for event ${row.eventId}`,
      );
    const body = await this.options.blobs.get(key);
    if (!body)
      throw new ArchivalError(`Overflow payload missing for ${row.eventId}`);
    const payload: unknown = await new Response(body).json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new ArchivalError(`Invalid overflow payload for ${row.eventId}`);
    overflowKeys.push(key);
    const { payloadBlobKey: _key, ...rest } = row;
    return { ...rest, payload: payload as Record<string, unknown> };
  }

  /**
   * Step 1 (SCAN) and the first half of step 2: scan from the oldest remaining row (no cursor
   * survives a batch), re-inline overflow payloads, then CAS `batch = committing`. Returns the rows
   * to append, or null when nothing is below the cutoff.
   */
  private async commitStart(
    lease: ArchiveLease,
    cutoff: Timestamp,
    stats: RunStats,
  ): Promise<StoredEvent[] | null> {
    const { store, blobs } = this.options;
    const { projectId, seq } = lease.state;
    const batchId = `${projectId}/${seq}`;
    const rows: StoredEvent[] = [];
    const overflowKeys: string[] = [];
    let bytes = 0;
    let cursor: Cursor | undefined;
    let full = false;
    do {
      const page = await store.events.scanOlderThan(projectId, cutoff, {
        cursor,
        limit: Math.min(SCAN_PAGE, this.limits.maxRows - rows.length),
      });
      for (const scanned of page.items) {
        stats.oldest ??= scanned.receivedAt;
        const row = await this.inline(scanned, overflowKeys);
        const size = estimateEventBytes(row);
        if (rows.length > 0 && bytes + size > this.limits.maxBytes) {
          // The inlined blob stays referenced only by its active row, so forget its key.
          if (scanned.payloadBlobKey) overflowKeys.pop();
          full = true;
          break;
        }
        rows.push(row);
        bytes += size;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor && !full && rows.length < this.limits.maxRows);
    if (!rows.length) return null;
    const summary = summarizeBatch(rows);
    let overflowKey: string | undefined;
    if (overflowKeys.length) {
      overflowKey = overflowManifestKey(batchId, lease.owner, lease.attempt++);
      await blobs.put(
        overflowKey,
        new TextEncoder().encode(JSON.stringify(overflowKeys)),
        { contentType: "application/json" },
      );
    }
    // The CAS is the fence: a stale holder fails here, before it can append anything.
    await this.advance(lease, (next) => {
      next.batch = {
        id: batchId,
        state: "committing",
        rowCount: summary.rowCount,
        dayRange: summary.dayRange,
        maxReceivedAt: summary.maxReceivedAt,
        ...(overflowKey ? { overflowKey } : {}),
      };
    });
    return rows;
  }

  /**
   * The rest of step 2 and steps 3 to 5 for the batch in `lease.state`. `rows` is set when this
   * loop just created the batch; absent means the batch was found in state (a resume), where a
   * `committing` batch is probed with `hasBatch`: if it is not in the archive nothing durable
   * existed, so the batch is abandoned (the next scan rebuilds it under the same batch id).
   */
  private async drive(
    lease: ArchiveLease,
    rows: StoredEvent[] | undefined,
    stats: RunStats,
  ): Promise<void> {
    const { archive, store } = this.options;
    const projectId = lease.state.projectId;
    const batch = lease.state.batch;
    if (!batch) return;
    if (batch.state === "committing") {
      if (rows) {
        await archive.append({
          batchId: batch.id,
          dayRange: batch.dayRange,
          rows,
        });
      } else if (!(await archive.hasBatch(batch.id, batch.dayRange))) {
        await this.advance(lease, (next) => {
          delete next.batch;
        });
        if (batch.overflowKey) await this.deleteBlob(batch.overflowKey);
        return;
      }
      // MARK
      await this.advance(lease, (next) => {
        if (!next.batch) return;
        next.batch.state = "committed";
        if (batch.maxReceivedAt > next.archivedThrough)
          next.archivedThrough = batch.maxReceivedAt;
      });
    }
    // DELETE: by the id list the committed snapshot holds, never a range or a rescan.
    const ids = await archive.batchEventIds(
      projectId,
      batch.id,
      batch.dayRange,
    );
    for (let offset = 0; offset < ids.length; offset += this.chunk)
      await store.events.deleteBatch(
        projectId,
        ids.slice(offset, offset + this.chunk),
      );
    await this.deleteOverflowBlobs(projectId, batch.overflowKey);
    // CLEAR
    await this.advance(lease, (next) => {
      delete next.batch;
      next.seq += 1;
    });
    stats.batches += 1;
    stats.rows += batch.rowCount;
    if (batch.overflowKey) await this.deleteBlob(batch.overflowKey);
  }

  private async deleteBlob(key: string): Promise<void> {
    try {
      await this.options.blobs.delete(key);
    } catch {
      // An orphan manifest or payload is swept by lifecycle rules.
      this.options.logger.warn("Blob deletion failed", { key });
    }
  }

  private async deleteOverflowBlobs(
    projectId: ProjectId,
    manifestKey: string | undefined,
  ): Promise<void> {
    if (!manifestKey) return;
    const body = await this.options.blobs.get(manifestKey);
    if (!body) return;
    const keys = JSON.parse(
      new TextDecoder().decode(await readAll(body)),
    ) as string[];
    for (const key of keys)
      if (ownsOverflowBlob(projectId, key)) await this.deleteBlob(key);
  }

  /**
   * Finish the batch in flight, if any, under an already held lease (used by the erasure worker).
   * Resumes from `batch.state`, probing `hasBatch` first when committing.
   */
  async driveBatchToCompletion(
    projectId: ProjectId,
    lease: ArchiveLease,
  ): Promise<void> {
    if (lease.state.projectId !== projectId)
      throw new ArchivalError("Lease belongs to another project");
    // An ArchiveLeaseLostError means another holder took over; the caller must stop.
    await this.drive(lease, undefined, { batches: 0, rows: 0 });
  }
}
