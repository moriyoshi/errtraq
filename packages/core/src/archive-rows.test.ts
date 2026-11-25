import { describe, expect, it } from "vitest";
import {
  ArchiveRowError,
  archiveRow,
  DEFAULT_BATCH_LIMITS,
  selectBatchPrefix,
  summarizeBatch,
} from "./archive-rows.js";
import type {
  EventId,
  IssueId,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "./domain.js";

const row = (
  id: string,
  receivedAt: string,
  extra: Partial<StoredEvent> = {},
): StoredEvent => ({
  projectId: "1" as ProjectId,
  eventId: id as EventId,
  issueId: "i" as IssueId,
  timestamp: receivedAt as Timestamp,
  receivedAt: receivedAt as Timestamp,
  level: "error",
  tags: { a: "b" },
  payload: { id },
  ...extra,
});

describe("archive rows", () => {
  it("derives the promoted columns and keeps the full event as JSON", () => {
    const event = row("e", "2024-01-01T00:00:00.000Z", {
      release: "r",
      environment: "prod",
      user: { id: "u", email: "e@x", username: "n", ipAddress: "1.2.3.4" },
    });
    expect(archiveRow("1/0", event)).toEqual({
      project_id: "1",
      event_id: "e",
      issue_id: "i",
      timestamp: "2024-01-01T00:00:00.000Z",
      received_at: "2024-01-01T00:00:00.000Z",
      level: "error",
      release: "r",
      environment: "prod",
      tags: { a: "b" },
      user_id: "u",
      user_email: "e@x",
      user_name: "n",
      user_ip: "1.2.3.4",
      event: JSON.stringify(event),
      archive_batch: "1/0",
    });
    expect(archiveRow("b", row("x", "2024-01-01T00:00:00.000Z"))).toMatchObject(
      {
        release: null,
        user_id: null,
        user_ip: null,
      },
    );
  });
  it("rejects a missing batch id and an un-inlined overflow payload", () => {
    expect(() => archiveRow("", row("e", "2024-01-01T00:00:00.000Z"))).toThrow(
      ArchiveRowError,
    );
    expect(() =>
      archiveRow(
        "b",
        row("e", "2024-01-01T00:00:00.000Z", { payloadBlobKey: "k" }),
      ),
    ).toThrow(ArchiveRowError);
  });
  it("summarizes count, UTC day range and max receivedAt", () => {
    expect(
      summarizeBatch([
        row("a", "2024-01-02T00:00:00.000Z"),
        row("b", "2024-01-01T23:59:59.999Z"),
        row("c", "2024-01-03T10:00:00.000Z"),
      ]),
    ).toEqual({
      rowCount: 3,
      dayRange: ["2024-01-01", "2024-01-03"],
      maxReceivedAt: "2024-01-03T10:00:00.000Z",
    });
    expect(() => summarizeBatch([])).toThrow(ArchiveRowError);
  });
  it("bounds a batch by rows and bytes and always keeps one row", () => {
    expect(DEFAULT_BATCH_LIMITS).toEqual({
      maxRows: 50_000,
      maxBytes: 128 * 1024 * 1024,
    });
    const rows = Array.from({ length: 5 }, (_, i) =>
      row(`e${i}`, "2024-01-01T00:00:00.000Z"),
    );
    expect(
      selectBatchPrefix(rows, { maxRows: 2, maxBytes: 1 << 20 }),
    ).toHaveLength(2);
    expect(selectBatchPrefix(rows, { maxRows: 99, maxBytes: 1 })).toHaveLength(
      1,
    );
    expect(selectBatchPrefix(rows)).toHaveLength(5);
    expect(() => selectBatchPrefix(rows, { maxRows: 0, maxBytes: 1 })).toThrow(
      ArchiveRowError,
    );
  });
});
