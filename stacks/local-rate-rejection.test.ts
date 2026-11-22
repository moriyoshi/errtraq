import { selections } from "@errtraq/core";
import { expect, it } from "vitest";
import { constructStack } from "../packages/cli/src/construction.js";
import local from "./local.js";

const copyStack = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value)) as T;
const roles = ["ingest", "api", "consumer", "cron"] as const;
const pathByModule = new Map(
  [...selections(local)].map(([path, selection]) => [
    selection.runtimeModule,
    path,
  ]),
);

it("enforces the issue limit through a constructed standalone stack", async () => {
  const { bootstrapProject, readDropped, toTimestamp } = await import(
    "@errtraq/core"
  );
  const {
    MemoryActiveStore,
    MemoryBlobStore,
    MemoryKV,
    MemoryQueue,
    DeterministicIdGen,
  } = await import("../packages/testing/src/index.js");
  const { create } = await import("@errtraq/platform-standalone");
  const store = new MemoryActiveStore();
  const blob = new MemoryBlobStore();
  const kv = new MemoryKV();
  const queue = Object.assign(new MemoryQueue(), { idle: async () => true });
  const project = await bootstrapProject({
    store,
    kv,
    ids: new DeterministicIdGen(),
    orgSlug: "org",
    projectSlug: "project",
  });
  const rateRejection = { issueRateLimit: { events: 1, windowSec: 86400 } };
  const stack = { ...copyStack(local), rateRejection };
  const adapters = { store, blob, kv, queue };
  const built = await constructStack(
    stack,
    roles,
    { ERRTRAQ_PORT: "0" },
    async (specifier) => {
      const path = pathByModule.get(specifier);
      if (path === "platform") return { create };
      if (!path || !Object.hasOwn(adapters, path))
        throw new Error("Unknown test module");
      return { create: () => adapters[path as keyof typeof adapters] };
    },
  );
  const platform = built.platform as ReturnType<typeof create>;
  const server = await platform.start();
  try {
    for (const n of [1, 2]) {
      const id = n.toString(16).padStart(32, "0");
      const body = `${JSON.stringify({ event_id: id })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify({ event_id: id, message: "one issue" })}\n`;
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/${project.project.id}/envelope/?sentry_key=${project.key.publicKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-sentry-envelope" },
          body,
        },
      );
      expect(response.status).toBe(200);
    }
    const { vi } = await import("vitest");
    await vi.waitFor(async () => {
      const page = await store.issues.list({
        projectId: project.project.id,
        sort: "lastSeen",
      });
      const issue = page.items[0];
      expect(page.items).toHaveLength(1);
      if (!issue) throw new Error("Issue not recorded yet");
      expect(issue.count).toBe(1);
      expect(
        await readDropped(
          kv,
          rateRejection,
          project.project.id,
          issue.id,
          toTimestamp(new Date()),
        ),
      ).toEqual({ count: 1, windowSec: 86400 });
    });
  } finally {
    await built.close();
  }
});
