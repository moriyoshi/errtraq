import {
  type ApiTokenId,
  bootstrapProject,
  type EventId,
  hashApiToken,
  type IssueId,
  summarizeBatch,
  type Timestamp,
} from "@moriyoshi/errtraq-core";
import { createApiApp } from "@moriyoshi/errtraq-http";
import { expect, it } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import {
  MemoryArchiveStore,
  MemoryBlobStore,
  MemoryKV,
} from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

async function setup(withArchive: boolean) {
  const store = new MemoryActiveStore();
  const archive = new MemoryArchiveStore();
  const clock = new FakeClock();
  const boot = await bootstrapProject({
    store,
    kv: new MemoryKV(clock),
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "project",
  });
  await store.projects.putToken({
    id: "token" as ApiTokenId,
    orgId: boot.org.id,
    tokenHash: await hashApiToken("secret"),
    scopes: ["event:read"],
  });
  const projectId = boot.project.id;
  const rows = [1, 2, 3, 4].map((n) => {
    const receivedAt = new Date(
      Date.parse(clock.now()) + n * 1000,
    ).toISOString() as Timestamp;
    return {
      projectId,
      issueId: "issue-1" as IssueId,
      eventId: `event-${n}` as EventId,
      receivedAt,
      timestamp: receivedAt,
      level: "error" as const,
      tags: {},
      payload: { message: `event ${n}` },
    };
  });
  for (const row of rows)
    await store.recordEvent(
      {
        projectId,
        issueId: row.issueId,
        eventId: row.eventId,
        receivedAt: row.receivedAt,
        timestamp: row.timestamp,
        fingerprint: "fp",
        title: "error",
        culprit: "test",
        type: "Error",
        metadata: {},
        level: "error",
      },
      row,
    );
  const app = createApiApp({
    store,
    clock,
    blobs: new MemoryBlobStore(),
    ...(withArchive ? { archive } : {}),
  });
  return { store, archive, app, rows, projectId };
}
const headers = { authorization: "Bearer secret" };
const nextCursor = (response: Response) =>
  /rel="next"; results="true"; cursor="([^"]+)"/.exec(
    response.headers.get("link") ?? "",
  )?.[1];

it("serves events, latest and detail across the watermark through the API", async () => {
  const c = await setup(true);
  // archive the three oldest, but keep the third in both tiers (DELETE-step window)
  const old = c.rows.slice(0, 3);
  await c.archive.append({
    batchId: "b",
    dayRange: summarizeBatch(old).dayRange,
    rows: old,
  });
  await c.store.events.deleteBatch(c.projectId, [
    old[0]?.eventId as EventId,
    old[1]?.eventId as EventId,
  ]);
  await c.store.meta.compareAndSetArchiveState(c.projectId, null, {
    projectId: c.projectId,
    version: 0,
    archivedThrough: c.rows[2]?.receivedAt as Timestamp,
    seq: 1,
  });
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const url = `/api/0/issues/issue-1/events/?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await c.app.request(url, { headers });
    expect(response.status).toBe(200);
    ids.push(
      ...(await response.json()).map((e: { eventID: string }) => e.eventID),
    );
    cursor = nextCursor(response);
    if (!cursor) break;
  }
  expect(ids).toEqual(["event-4", "event-3", "event-2", "event-1"]);
  const detail = await c.app.request("/api/0/issues/issue-1/events/event-1/", {
    headers,
  });
  expect(detail.status).toBe(200);
  // the newest event leaves the active store: latest still resolves through the archive
  const newest = c.rows[3];
  if (!newest) throw new Error("rows");
  await c.archive.append({
    batchId: "b2",
    dayRange: summarizeBatch([newest]).dayRange,
    rows: [newest],
  });
  await c.store.events.deleteBatch(c.projectId, [newest.eventId]);
  const latest = await c.app.request("/api/0/issues/issue-1/events/latest/", {
    headers,
  });
  expect(latest.status).toBe(200);
  expect((await latest.json()).eventID).toBe("event-4");
  const byProject = await c.app.request(
    "/api/0/projects/org/project/events/event-4/",
    { headers },
  );
  expect(byProject.status).toBe(200);
});

it("returns not found for archived events when no archive is configured", async () => {
  const c = await setup(false);
  await c.store.events.deleteBatch(c.projectId, [
    c.rows[3]?.eventId as EventId,
  ]);
  const latest = await c.app.request("/api/0/issues/issue-1/events/latest/", {
    headers,
  });
  expect(latest.status).toBe(404);
});
