import type {
  Day,
  EventPosition,
  IssueId,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "@moriyoshi/errtraq-core";
import { encodeStagedBatch } from "@moriyoshi/errtraq-core";
import { expect, it } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryArchiveStore } from "./memory-other.js";

it("merges keyset pages without dropping tails or duplicating overlapping events", async () => {
  const projectId = "1" as ProjectId;
  const issueId = "issue" as IssueId;
  const active = new MemoryActiveStore();
  const archive = new MemoryArchiveStore();
  const rows: StoredEvent[] = [1, 2, 3, 4, 5, 6].map((n) => ({
    projectId,
    issueId,
    eventId: `e${n}` as StoredEvent["eventId"],
    receivedAt: `2024-01-01T00:00:0${Math.ceil(n / 2)}.000Z` as Timestamp,
    timestamp: `2024-01-01T00:00:0${Math.ceil(n / 2)}.000Z` as Timestamp,
    level: "error",
    tags: {},
    payload: {},
  }));
  for (const row of rows.filter((_, i) => [0, 2, 3, 5].includes(i)))
    await active.recordEvent(
      {
        projectId,
        issueId,
        eventId: row.eventId,
        fingerprint: "fp",
        timestamp: row.timestamp,
        receivedAt: row.receivedAt,
        title: "x",
        culprit: "x",
        level: "error",
        type: "error",
        metadata: {},
      },
      row,
    );
  await archive.blobs.put(
    "stage",
    encodeStagedBatch(
      "b",
      rows.filter((_, i) => [1, 2, 4, 5].includes(i)),
    ).bytes,
  );
  await archive.append({
    batchId: "b",
    stagedKey: "stage",
    dayRange: ["2024-01-01" as Day, "2024-01-01" as Day],
  });
  let after: EventPosition | undefined;
  const result: string[] = [];
  for (;;) {
    const [a, b] = await Promise.all([
      active.events.listByIssue({ projectId, after, limit: 2 }),
      archive.query({ projectId, after, limit: 2 }),
    ]);
    const unique = new Map(
      [...a.items, ...b.items].map((row) => [row.eventId, row]),
    );
    const merged = [...unique.values()]
      .sort(
        (x, y) =>
          y.receivedAt.localeCompare(x.receivedAt) ||
          y.eventId.localeCompare(x.eventId),
      )
      .slice(0, 2);
    if (!merged.length) break;
    result.push(...merged.map((row) => row.eventId));
    const last = merged.at(-1);
    if (!last) throw new Error("empty merge");
    after = { receivedAt: last.receivedAt, eventId: last.eventId };
  }
  expect(result).toEqual(["e6", "e5", "e4", "e3", "e2", "e1"]);
});
