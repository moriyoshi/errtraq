import {
  type ArchiveStore,
  type Day,
  decodeCursor,
  type EventId,
  type EventPage,
  type EventPosition,
  type EventQuery,
  encodeCursor,
  eventCursorScope,
  InvalidCursorError,
  type ProjectId,
  pageLimit,
  type StoredEvent,
  type Timestamp,
  UnsupportedQueryError,
} from "@moriyoshi/errtraq-core";
import { rowDeleteModeFor } from "../stack.js";
import { CREDENTIAL_REFRESH_SKEW_MS, isS3AuthFailure } from "./recovery.js";
import type {
  EngineSession,
  EngineSettings,
  SessionFactory,
} from "./session.js";
import {
  appendStatement,
  batchEventIdsStatement,
  ensureTableStatements,
  getEventStatement,
  hasBatchStatement,
  queryStatement,
  snapshotsStatement,
  tableExistsStatement,
} from "./sql.js";

/**
 * DuckDB reports a lost optimistic commit as text (the REST catalog answered 409, or the commit
 * requirement failed). Match conservatively on the words of those failures.
 */
export function isCommitConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b409\b|CommitFailed|commit (?:conflict|failed)|conflict(?:ing)? commit|requirement failed|assert-(?:ref|table|last|default|current)|concurrent (?:update|modification|commit)/i.test(
    message,
  );
}

export interface StoreOptions {
  namespace: string;
  engine: EngineSettings;
  /** Opens the long-lived session lazily; `ensureTable` opens its own. */
  openSession: SessionFactory;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** Full-jitter exponential backoff. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  return Math.floor(random() * Math.min(maxMs, baseMs * 2 ** attempt));
}

export class DuckDbArchiveStore implements ArchiveStore {
  readonly capabilities: ArchiveStore["capabilities"];
  private session: Promise<EngineSession> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly options: StoreOptions) {
    this.capabilities = { rowDelete: rowDeleteModeFor(options.engine) };
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  private get namespace(): string {
    return this.options.namespace;
  }

  /**
   * Operations share one connection and run one at a time. The S3 secret is renewed ahead of the
   * credentials' expiry. With `repeatable` (reads, `hasBatch`, `append`: safe to run again), an S3
   * authentication failure renews the secret and runs the operation once more. A failure after
   * which the connection no longer answers discards the session so the next operation opens a
   * fresh one; the original error is always the one thrown.
   */
  private exclusive<T>(
    fn: (session: EngineSession) => Promise<T>,
    repeatable = false,
  ): Promise<T> {
    const run = async () => {
      this.session ??= this.options.openSession().catch((error: unknown) => {
        this.session = undefined;
        throw error;
      });
      const opened = this.session;
      const session = await opened;
      try {
        const expiresAt = session.credentialsExpireAt?.();
        if (
          expiresAt !== undefined &&
          this.now() >= expiresAt - CREDENTIAL_REFRESH_SKEW_MS
        )
          await session.refreshCredentials?.();
        try {
          return await fn(session);
        } catch (error) {
          if (
            !repeatable ||
            !session.refreshCredentials ||
            !isS3AuthFailure(error)
          )
            throw error;
          await session.refreshCredentials();
          return await fn(session);
        }
      } catch (error) {
        await this.discardIfDead(opened, session);
        throw error;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private repeatable<T>(
    fn: (session: EngineSession) => Promise<T>,
  ): Promise<T> {
    return this.exclusive(fn, true);
  }

  /** After a failure: drop the cached session when the connection no longer answers a probe. */
  private async discardIfDead(
    opened: Promise<EngineSession>,
    session: EngineSession,
  ): Promise<void> {
    try {
      await session.all("SELECT 1");
      return;
    } catch {
      // The connection is unusable (for example the DuckDB instance was invalidated by a fatal error).
    }
    if (this.session === opened) this.session = undefined;
    try {
      session.close();
    } catch {
      // Already closed or broken beyond closing.
    }
  }

  /**
   * Create the table once (schema, columns, format version, partition `day(received_at)`, the D13
   * sort order, `write.delete.mode = merge-on-read`). It runs in a session of its own that is
   * closed afterwards: the partition spec and sort order must exist before the first INSERT of
   * any other session. Returns whether this call created the table.
   */
  async ensureTable(): Promise<{ created: boolean }> {
    const session = await this.options.openSession();
    try {
      const exists = tableExistsStatement(this.namespace);
      const rows = await session.all(exists.sql, exists.params);
      if (Number(rows[0]?.c ?? 0) > 0) return { created: false };
      for (const sql of ensureTableStatements(
        this.namespace,
        this.options.engine.formatVersion,
      ))
        await this.withRetry(() => session.run(sql));
      return { created: true };
    } finally {
      session.close();
    }
  }

  async close(): Promise<void> {
    await this.tail;
    const session = this.session;
    this.session = undefined;
    if (session) (await session.catch(() => undefined))?.close();
  }

  /** Retry commit conflicts with jittered exponential backoff; anything else is thrown at once. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.options.engine.retry;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!isCommitConflict(error) || attempt + 1 >= maxAttempts) throw error;
        await this.sleep(
          backoffDelay(attempt, baseDelayMs, maxDelayMs, this.random),
        );
      }
    }
  }

  private async probe(
    session: EngineSession,
    batchId: string,
    dayRange: [Day, Day],
    snapshotId?: string,
  ): Promise<boolean> {
    const statement = hasBatchStatement(
      this.namespace,
      batchId,
      dayRange,
      snapshotId === undefined ? {} : { snapshotId },
    );
    return (await session.all(statement.sql, statement.params)).length > 0;
  }

  /** The oldest snapshot that holds the batch (binary search by time travel), or the latest. */
  private async snapshotOf(
    session: EngineSession,
    batchId: string,
    dayRange: [Day, Day],
  ): Promise<string> {
    const list = snapshotsStatement(this.namespace);
    const ids = (await session.all(list.sql, list.params)).map((row) =>
      String(row.snapshot_id),
    );
    const latest = ids.at(-1);
    if (latest === undefined)
      throw new Error("archive-iceberg: the events table has no snapshot");
    let low = 0;
    let high = ids.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (await this.probe(session, batchId, dayRange, ids[mid])) high = mid;
      else low = mid + 1;
    }
    return ids[low] ?? latest;
  }

  append(batch: {
    batchId: string;
    dayRange: [Day, Day];
    rows: StoredEvent[];
  }): Promise<{ snapshotId: string; rowCount: number }> {
    const { batchId, dayRange, rows } = batch;
    if (!batchId) return Promise.reject(new Error("Missing batch id"));
    if (rows.length === 0) return Promise.reject(new Error("Empty batch"));
    return this.repeatable(async (session) => {
      // Statement construction validates the day range and encodes the rows before any commit.
      const insert = appendStatement(this.namespace, batchId, rows);
      for (let attempt = 0; ; attempt++) {
        // Idempotency rests on `archive_batch` plus this day-pruned probe (DuckDB cannot set
        // snapshot summary properties). Re-checked on every attempt: a conflicted INSERT whose
        // outcome was lost may have committed after all.
        if (!(await this.probe(session, batchId, dayRange))) {
          try {
            await session.run(insert.sql, insert.params);
          } catch (error) {
            const { maxAttempts, baseDelayMs, maxDelayMs } =
              this.options.engine.retry;
            if (!isCommitConflict(error) || attempt + 1 >= maxAttempts)
              throw error;
            await this.sleep(
              backoffDelay(attempt, baseDelayMs, maxDelayMs, this.random),
            );
            continue;
          }
        }
        return {
          snapshotId: await this.snapshotOf(session, batchId, dayRange),
          rowCount: rows.length,
        };
      }
    });
  }

  hasBatch(batchId: string, dayRange: [Day, Day]): Promise<boolean> {
    return this.repeatable((session) => this.probe(session, batchId, dayRange));
  }

  batchEventIds(
    projectId: ProjectId,
    batchId: string,
    dayRange: [Day, Day],
  ): Promise<EventId[]> {
    return this.repeatable(async (session) => {
      const statement = batchEventIdsStatement(
        this.namespace,
        projectId,
        batchId,
        dayRange,
      );
      const rows = await session.all(statement.sql, statement.params);
      return rows.map((row) => String(row.event_id) as EventId);
    });
  }

  async query(query: EventQuery): Promise<EventPage> {
    const scope = eventCursorScope(query);
    const keys = decodeCursor(query.cursor, scope);
    if (
      keys &&
      (keys.length !== 2 ||
        typeof keys[0] !== "string" ||
        typeof keys[1] !== "string")
    )
      throw new InvalidCursorError("Invalid event cursor");
    const boundary: EventPosition | undefined = keys
      ? { receivedAt: keys[0] as Timestamp, eventId: keys[1] as EventId }
      : query.after;
    const limit = pageLimit(query.limit);
    const statement = queryStatement(this.namespace, query, boundary, limit);
    return this.repeatable(async (session) => {
      const rows = await session.all(statement.sql, statement.params);
      const items = rows
        .slice(0, limit)
        .map((row) => JSON.parse(String(row.event)) as StoredEvent);
      const last = items.at(-1);
      const hasMore = rows.length > limit && last !== undefined;
      return {
        items,
        hasMore,
        nextCursor: hasMore
          ? encodeCursor(scope, [last.receivedAt, last.eventId])
          : null,
      };
    });
  }

  getEvent(
    projectId: ProjectId,
    eventId: EventId,
    hintTs?: Timestamp,
  ): Promise<StoredEvent | null> {
    return this.repeatable(async (session) => {
      const lookup = async (hint?: Day) => {
        const statement = getEventStatement(
          this.namespace,
          projectId,
          eventId,
          hint,
        );
        const row = (await session.all(statement.sql, statement.params))[0];
        return row ? (JSON.parse(String(row.event)) as StoredEvent) : null;
      };
      if (hintTs) {
        // The hint (for example the issue's last receivedAt) usually names the event's day. A
        // wrong hint costs one more point lookup, never a wrong answer.
        const found = await lookup(hintTs.slice(0, 10) as Day);
        if (found) return found;
      }
      return lookup();
    });
  }

  // TODO(M4l): row-level erasure (deletion vectors), physical erasure and snapshot expiry.
  deleteWhere(): Promise<never> {
    return Promise.reject(
      new UnsupportedQueryError(
        "archive-iceberg: deleteWhere is not implemented yet (TODO(M4l))",
      ),
    );
  }
  hardErase(): Promise<never> {
    return Promise.reject(
      new UnsupportedQueryError(
        "archive-iceberg: hardErase is not implemented yet (TODO(M4l))",
      ),
    );
  }
  expireSnapshots(): Promise<never> {
    return Promise.reject(
      new UnsupportedQueryError(
        "archive-iceberg: expireSnapshots is not implemented yet (TODO(M4l))",
      ),
    );
  }
}
