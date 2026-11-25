import {
  type EventId,
  EventQueryService,
  type IssueId,
  type ProjectId,
  type Timestamp,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { federationSuite } from "./federation.js";
import { MemoryActiveStore } from "./memory-active.js";

federationSuite(async () => new MemoryActiveStore());

describe("EventQueryService without an archive", () => {
  it("is a pass-through: source cursors and results are untouched", async () => {
    const store = new MemoryActiveStore();
    const projectId = "1" as ProjectId;
    for (let i = 0; i < 3; i++) {
      const receivedAt = new Date(
        Date.UTC(2024, 0, 1, 0, 0, i),
      ).toISOString() as Timestamp;
      const base = {
        projectId,
        issueId: "iss" as IssueId,
        eventId: `e${i}` as EventId,
        timestamp: receivedAt,
        receivedAt,
        level: "error" as const,
      };
      await store.recordEvent(
        {
          ...base,
          fingerprint: "fp",
          title: "t",
          culprit: "",
          type: "error",
          metadata: {},
        },
        { ...base, tags: {}, payload: {} },
      );
    }
    const service = new EventQueryService({ store });
    const direct = await store.events.listByIssue({ projectId, limit: 2 });
    expect(await service.listByIssue({ projectId, limit: 2 })).toEqual(direct);
    expect((await service.getEvent(projectId, "e1" as EventId))?.eventId).toBe(
      "e1",
    );
    expect(await service.getEvent(projectId, "zz" as EventId)).toBeNull();
  });
});
