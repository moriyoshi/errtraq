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
    publicApiUrl?: string;
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
    ...(options.publicApiUrl ? { publicApiUrl: options.publicApiUrl } : {}),
    ...(options.cors ? { cors: options.cors } : {}),
  });
  return { store, archive, app, boot, rows, projectId, clock };
}
const send = (
  c: Requester,
  path: string,
  headers: Record<string, string> = {},
) => Promise.resolve(c.app.request(path, { headers: { ...auth, ...headers } }));
const PUBLIC = "https://errtraq.example.com";

describe("configured public API URL", () => {
  it("builds Link and permalinks from it, keeping path and query", async () => {
    const c = await setup({ publicApiUrl: PUBLIC, events: 3 });
    const list = await send(
      c,
      "http://function.lambda-url.test/api/0/issues/issue-1/events/?limit=1",
    );
    const link = list.headers.get("link") ?? "";
    expect(link).toContain(`<${PUBLIC}/api/0/issues/issue-1/events/?limit=1`);
    expect(link).not.toContain("function.lambda-url.test");
    const issue = await (
      await send(c, "http://function.lambda-url.test/api/0/issues/issue-1/")
    ).json();
    expect(issue.permalink).toBe(`${PUBLIC}/organizations/org/issues/issue-1/`);
    const releases = await send(
      c,
      "http://function.lambda-url.test/api/0/projects/org/project/releases/",
    );
    expect(releases.headers.get("link")).toContain(`<${PUBLIC}/api/0/`);
  });

  it("ignores forwarded host headers", async () => {
    const c = await setup({ publicApiUrl: PUBLIC });
    const forged = {
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
      "x-forwarded-port": "81",
      forwarded: "host=evil.example;proto=http",
      host: "evil.example",
    };
    const res = await send(
      c,
      "http://function.lambda-url.test/api/0/issues/issue-1/events/?limit=1",
      forged,
    );
    expect(res.headers.get("link")).not.toContain("evil.example");
    expect(res.headers.get("link")).toContain(PUBLIC);
    const issue = await (
      await send(
        c,
        "http://function.lambda-url.test/api/0/issues/issue-1/",
        forged,
      )
    ).json();
    expect(issue.permalink).toBe(`${PUBLIC}/organizations/org/issues/issue-1/`);
  });

  it("keeps the request URL without the setting, and ignores forwarded headers then too", async () => {
    const c = await setup();
    const res = await send(
      c,
      "http://function.lambda-url.test/api/0/issues/issue-1/events/?limit=1",
      {
        "x-forwarded-host": "evil.example",
      },
    );
    expect(res.headers.get("link")).toContain(
      "http://function.lambda-url.test/",
    );
    expect(res.headers.get("link")).not.toContain("evil.example");
  });

  it("refuses a value that is not an origin", async () => {
    for (const bad of [
      "ftp://x.test",
      "https://u:p@x.test",
      "https://x.test/api",
      "https://x.test?q=1",
      "not a url",
    ])
      await expect(setup({ publicApiUrl: bad })).rejects.toThrow(
        /public API URL/,
      );
  });
});
