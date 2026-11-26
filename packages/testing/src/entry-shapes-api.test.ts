import {
  type ApiTokenId,
  bootstrapProject,
  type EventId,
  hashApiToken,
  type IssueId,
  toTimestamp,
} from "@moriyoshi/errtraq-core";
import { createApiApp } from "@moriyoshi/errtraq-http";
import { describe, expect, it } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import {
  MemoryArchiveStore,
  MemoryBlobStore,
  MemoryKV,
} from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

type Requester = {
  app: {
    request(path: string, init?: RequestInit): Response | Promise<Response>;
  };
};
const auth = { authorization: "Bearer errtraq_secret" };

async function setup(
  options: {
    archive?: boolean;
    ingestUrl?: string;
    cors?: { origins: string[]; maxAgeSec?: number };
    events?: number;
    payload?: Record<string, unknown>;
  } = {},
) {
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
    tokenHash: await hashApiToken("errtraq_secret"),
    scopes: ["event:read", "event:write"],
  });
  const projectId = boot.project.id;
  const rows = [];
  for (let n = 1; n <= (options.events ?? 3); n++) {
    const receivedAt = toTimestamp(
      new Date(Date.parse(clock.now()) + n * 1000),
    );
    const row = {
      projectId,
      issueId: "issue-1" as IssueId,
      eventId: `event-${n}` as EventId,
      receivedAt,
      timestamp: receivedAt,
      level: "error" as const,
      tags: {},
      payload: { message: `event ${n}`, ...options.payload },
    };
    rows.push(row);
    await store.recordEvent(
      {
        projectId,
        issueId: row.issueId,
        eventId: row.eventId,
        receivedAt,
        timestamp: receivedAt,
        fingerprint: "fp",
        title: "error",
        culprit: "test",
        type: "Error",
        metadata: {},
        level: "error",
      },
      row,
    );
  }
  const app = createApiApp({
    store,
    clock,
    blobs: new MemoryBlobStore(),
    ...(options.archive ? { archive } : {}),
    ...(options.ingestUrl ? { ingestUrl: options.ingestUrl } : {}),
    ...(options.cors ? { cors: options.cors } : {}),
  });
  return { store, archive, app, boot, rows, projectId, clock };
}
const get = (c: Requester, path: string) =>
  Promise.resolve(c.app.request(path, { headers: auth }));

const crumb = { type: "default", category: "ui.click", message: "clicked" };
const frame = { type: "Error", value: "boom" };

/** Entry `data` of one stored event, read through the route (the SDK shape is stored as sent). */
async function entries(payload: Record<string, unknown>) {
  const c = await setup({ events: 1, payload });
  const res = await get(c, "/api/0/issues/issue-1/events/latest/");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    entries: Array<{ type: string; data: unknown }>;
  };
  return Object.fromEntries(body.entries.map((e) => [e.type, e.data]));
}

describe("breadcrumbs and exception entry shapes", () => {
  it("wraps a bare breadcrumbs array in { values }", async () => {
    expect((await entries({ breadcrumbs: [crumb] })).breadcrumbs).toEqual({
      values: [crumb],
    });
  });

  it("keeps the { values } form as it is", async () => {
    expect(
      (await entries({ breadcrumbs: { values: [crumb] } })).breadcrumbs,
    ).toEqual({ values: [crumb] });
  });

  it("wraps a bare exception array in { values }", async () => {
    expect((await entries({ exception: [frame] })).exception).toEqual({
      values: [frame],
    });
  });

  it("keeps the { values } exception form as it is", async () => {
    expect(
      (await entries({ exception: { values: [frame] } })).exception,
    ).toEqual({ values: [frame] });
  });

  it("wraps an empty array too", async () => {
    // An empty array is truthy; the entry is still emitted, with an empty list.
    expect((await entries({ breadcrumbs: [] })).breadcrumbs).toEqual({
      values: [],
    });
  });
});
