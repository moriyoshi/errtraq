import { describe, expect, it, vi } from "vitest";
import type { EventId, ProjectId, StoredEvent, Timestamp } from "./domain.js";
import type { BlobStore } from "./ports.js";
import { deleteExpiredEvents } from "./retention.js";

const project = "7" as ProjectId;
const now = "2024-03-01T00:00:00.000Z" as Timestamp;
const row = (id: string, blobKey?: string): StoredEvent => ({
  projectId: project,
  eventId: id as EventId,
  issueId: "i" as StoredEvent["issueId"],
  timestamp: "2024-01-01T00:00:00.000Z" as Timestamp,
  receivedAt: "2024-01-01T00:00:00.000Z" as Timestamp,
  level: "error",
  tags: {},
  payload: {},
  ...(blobKey ? { payloadBlobKey: blobKey } : {}),
});
function setup(rows: StoredEvent[]) {
  const calls: string[] = [];
  const remaining = [...rows];
  const events = {
    scanOlderThan: vi.fn(
      async (_p: ProjectId, _c: Timestamp, o?: { limit?: number }) => ({
        items: remaining.slice(0, o?.limit ?? 100),
        nextCursor: null,
      }),
    ),
    deleteBatch: vi.fn(async (_p: ProjectId, ids: EventId[]) => {
      calls.push(`events:${ids.join(",")}`);
      for (const id of ids)
        remaining.splice(
          remaining.findIndex((r) => r.eventId === id),
          1,
        );
    }),
  };
  const blobs = {
    delete: vi.fn(async (key: string) => {
      calls.push(`blob:${key}`);
    }),
  };
  const logger = { warn: vi.fn() };
  const run = (extra: { maxEvents?: number; retentionDays?: number } = {}) =>
    deleteExpiredEvents({
      store: { events } as never,
      blobs: blobs as unknown as BlobStore,
      logger,
      projectId: project,
      retentionDays: 30,
      now,
      ...extra,
    });
  return { calls, events, blobs, logger, remaining, run };
}

describe("deleteExpiredEvents", () => {
  it("deletes the event before its overflow blob and uses the retention cutoff", async () => {
    const s = setup([row("a", "payloads/7/a"), row("b")]);
    expect(await s.run()).toEqual({
      deleted: 2,
      blobFailures: 0,
      hasMore: false,
    });
    expect(s.calls).toEqual(["events:a,b", "blob:payloads/7/a"]);
    expect(s.events.scanOlderThan.mock.calls[0]?.[1]).toBe(
      "2024-01-31T00:00:00.000Z",
    );
  });
  it("never deletes a blob when the event deletion fails", async () => {
    const s = setup([row("a", "payloads/7/a")]);
    s.events.deleteBatch.mockRejectedValueOnce(new Error("store down"));
    await expect(s.run()).rejects.toThrow("store down");
    expect(s.blobs.delete).not.toHaveBeenCalled();
    expect(s.remaining).toHaveLength(1);
  });
  it("leaves an orphan, not a failure, when the blob deletion fails after the event is gone", async () => {
    const s = setup([row("a", "payloads/7/a"), row("b", "payloads/7/b/x")]);
    s.blobs.delete.mockRejectedValueOnce(new Error("blob down"));
    expect(await s.run()).toMatchObject({ deleted: 2, blobFailures: 1 });
    expect(s.remaining).toHaveLength(0);
    expect(s.logger.warn).toHaveBeenCalledWith(
      "Overflow payload deletion failed",
      { eventId: "a" },
    );
  });
  it("only deletes overflow payloads of the same project", async () => {
    const s = setup([
      row("a", "payloads/records/7/a/1-x"),
      row("b", "payloads/8/b"),
    ]);
    await s.run();
    expect(s.blobs.delete).not.toHaveBeenCalled();
    expect(s.logger.warn).toHaveBeenCalledTimes(2);
  });
  it("bounds the work per call", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`e${i}`));
    const s = setup(rows);
    expect(await s.run({ maxEvents: 30 })).toMatchObject({
      deleted: 30,
      hasMore: true,
    });
    expect(s.remaining).toHaveLength(30);
  });
  it("rejects an invalid retention", async () => {
    await expect(setup([]).run({ retentionDays: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});
