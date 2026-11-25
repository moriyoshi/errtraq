import {
  ARCHIVE_PROJECT_TOPIC,
  createCronHandler,
  type EventId,
  type Message,
  type OrgId,
  type Project,
  type ProjectId,
  runArchivePlanner,
  type Timestamp,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { archivalSuite, scenario } from "./archival.js";
import { MemoryActiveStore } from "./memory-active.js";

archivalSuite(async () => new MemoryActiveStore());

const logger = { info() {}, warn() {}, error() {} };

describe("archive planner", () => {
  it("sends one keyed message per project across pages, identically on a re-run", async () => {
    const store = new MemoryActiveStore();
    await store.projects.putOrg({ id: "o" as OrgId, slug: "o", name: "o" });
    for (let i = 1; i <= 5; i++)
      await store.projects.put({
        id: String(i) as ProjectId,
        orgId: "o" as OrgId,
        slug: `p${i}`,
        name: "p",
        retentionDays: 30,
      } satisfies Project);
    const sent: { topic: string; messages: Message[] }[] = [];
    const queue = {
      send: async (topic: string, messages: Message[]) => {
        sent.push({ topic, messages });
      },
    };
    const tick = "2024-03-01T00:00:00.000Z" as Timestamp;
    expect(
      await runArchivePlanner(
        { projects: store.projects, queue, logger },
        tick,
        2,
      ),
    ).toEqual({ projects: 5 });
    expect(sent).toHaveLength(3);
    const first = sent.flatMap((s) => s.messages);
    expect(sent.every((s) => s.topic === ARCHIVE_PROJECT_TOPIC)).toBe(true);
    expect(first.map((m) => m.body)).toEqual(
      [1, 2, 3, 4, 5].map((i) => ({ projectId: String(i) })),
    );
    sent.length = 0;
    await runArchivePlanner(
      { projects: store.projects, queue, logger },
      tick,
      2,
    );
    expect(sent.flatMap((s) => s.messages).map((m) => m.key)).toEqual(
      first.map((m) => m.key),
    );
    expect(new Set(first.map((m) => m.key)).size).toBe(5);
    sent.length = 0;
    await runArchivePlanner(
      { projects: store.projects, queue, logger },
      "2024-03-01T01:00:00.000Z" as Timestamp,
      2,
    );
    expect(sent.flatMap((s) => s.messages).map((m) => m.key)).not.toContain(
      first[0]?.key,
    );
  });

  it("runs through the archive-planner cron job only when archival is wired", async () => {
    const s = await scenario(async () => new MemoryActiveStore());
    const sent: Message[] = [];
    const queue = {
      send: async (_t: string, messages: Message[]) => {
        sent.push(...messages);
      },
    };
    const plain = createCronHandler(logger);
    await plain("archive-planner", s.clock.now());
    expect(sent).toEqual([]);
    const wired = createCronHandler(logger, undefined, undefined, {
      projects: s.store.projects,
      queue,
    });
    await wired("archive-planner", s.clock.now());
    expect(sent.map((m) => m.body)).toEqual([{ projectId: "1" }]);
  });
});

describe("retention cron job", () => {
  it("deletes expired events and overflow blobs for a stack without an archive", async () => {
    const s = await scenario(async () => new MemoryActiveStore());
    const cron = createCronHandler(logger, undefined, undefined, undefined, {
      store: s.store,
      blobs: s.blobs,
    });
    await cron("retention", s.clock.now());
    expect(await s.activeOldIds()).toEqual([]);
    expect(await s.blobs.head("payloads/1/old2")).toBeNull();
    for (const e of s.fixture.recent)
      expect(await s.store.events.get(e.projectId, e.eventId)).not.toBeNull();
    expect(await s.archivedIds()).toEqual([]);
  });

  it("leaves events to archival when an archive is selected", async () => {
    const s = await scenario(async () => new MemoryActiveStore());
    const cron = createCronHandler(logger, undefined, undefined, undefined, {
      store: s.store,
      blobs: s.blobs,
      archived: true,
    });
    await cron("retention", s.clock.now());
    expect(await s.activeOldIds()).toHaveLength(5);
    expect(
      await s.store.events.get(
        s.fixture.old[0]?.projectId as ProjectId,
        "old0" as EventId,
      ),
    ).not.toBeNull();
  });
});
