import type {
  EventId,
  IssueId,
  Occurrence,
  ProjectId,
  StoredEvent,
  Timestamp,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { compositeIndexes, terraformIndexes } from "./indexes.js";
import { configSchema, firestoreStore, infra, manifest } from "./stack.js";
import { makeFakeStore } from "./test-store.js";

const project = "1" as ProjectId;
const t = (n: number) =>
  `2024-01-01T00:00:${String(n).padStart(2, "0")}.000Z` as Timestamp;
const occurrence = (id: string, n: number): Occurrence => ({
  projectId: project,
  issueId: "i1" as IssueId,
  eventId: id as EventId,
  fingerprint: "fp",
  receivedAt: t(n),
  timestamp: t(n),
  title: "t",
  culprit: "c",
  level: "error",
  type: "error",
  metadata: {},
});
const event = (
  id: string,
  n: number,
  payload: Record<string, unknown> = {},
): StoredEvent => ({
  projectId: project,
  eventId: id as EventId,
  issueId: "i1" as IssueId,
  timestamp: t(n),
  receivedAt: t(n),
  level: "error",
  tags: {},
  payload,
});

describe("Firestore store specifics", () => {
  it("counts exactly under concurrent recordEvent on one issue", async () => {
    const { store } = makeFakeStore();
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        store.recordEvent(occurrence(`e${i}`, i % 50), event(`e${i}`, i % 50)),
      ),
    );
    expect((await store.issues.get(project, "i1" as IssueId))?.count).toBe(60);
  });

  it("rejects an event that cannot fit one document and writes nothing", async () => {
    const { store, fake } = makeFakeStore();
    const wide = Array.from({ length: 20 }, () =>
      btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(60000))),
      ),
    ).join("");
    await expect(
      store.recordEvent(occurrence("big", 1), event("big", 1, { wide })),
    ).rejects.toThrow("exceeds 1 MiB");
    expect(fake.docs.size).toBe(0);
  });

  it("deletes more than 500 events in bounded commits", async () => {
    const { store, fake } = makeFakeStore();
    const ids = Array.from({ length: 1100 }, (_, i) => `d${i}` as EventId);
    await store.events.deleteBatch(project, ids);
    const commits = fake.requests.filter((r) => r.action === "commit");
    expect(
      commits.map((c) => (c.body as { writes: unknown[] }).writes.length),
    ).toEqual([500, 500, 100]);
  });

  it("round trips events with awkward but legal ids and payload bytes", async () => {
    const { store } = makeFakeStore();
    const id = "a.b_c:d@e+f=g~h-1";
    const e = event(id, 1, {
      text: "日本語 \u0000 ok",
      nested: { n: [1, 2.5] },
    });
    await store.recordEvent(occurrence(id, 1), e);
    expect(await store.events.get(project, id as EventId)).toEqual(e);
  });

  it("is idempotent when a transaction is retried after an aborted commit", async () => {
    let aborts = 2;
    const { store } = makeFakeStore({
      intercept: (r) =>
        r.action === "commit" &&
        (r.body as { transaction?: string }).transaction &&
        aborts-- > 0
          ? Response.json(
              { error: { code: 409, status: "ABORTED", message: "" } },
              { status: 409 },
            )
          : undefined,
    });
    const result = await store.recordEvent(occurrence("x", 1), event("x", 1));
    expect(result.inserted).toBe(true);
    expect((await store.issues.get(project, "i1" as IssueId))?.count).toBe(1);
  });

  it("migrate creates the schema document and rejects a foreign version", async () => {
    const { store, fake } = makeFakeStore();
    await store.migrate();
    await store.migrate();
    const doc = fake.docs.get("meta/schema");
    expect(doc?.fields.schemaVersion).toEqual({ integerValue: "1" });
    if (doc) doc.fields.schemaVersion = { integerValue: "2" };
    await expect(store.migrate()).rejects.toThrow("schema version");
  });
});

describe("Firestore store deployment configuration", () => {
  it("requires an explicit project and location", () => {
    expect(configSchema.safeParse({}).success).toBe(false);
    expect(configSchema.safeParse({ projectId: "p" }).success).toBe(false);
    expect(
      configSchema.safeParse({ projectId: "p", location: "l" }).success,
    ).toBe(true);
  });
  it("declares truthful capabilities and the infra descriptor", () => {
    expect(manifest.capabilities).toMatchObject({
      textSearch: false,
      lastSeenRangeOnOtherSort: false,
      deleteStrategy: "explicit",
    });
    expect(infra.module).toMatchObject({
      provider: "gcp",
      component: "firestore",
    });
    const inputs = infra.inputs(
      { projectId: "p", location: "l" },
      { functions: [], triggers: [] },
    );
    expect(inputs.purpose).toBe("store");
    expect(inputs.location).toBe("l");
    expect(firestoreStore({ projectId: "p", location: "l" }).manifest.id).toBe(
      "store-firestore",
    );
  });
  it("renders indexes in Terraform vocabulary", () => {
    const rendered = terraformIndexes();
    expect(rendered).toHaveLength(compositeIndexes.length);
    expect(rendered[0]?.fields.every((f) => f.field_path !== "__name__")).toBe(
      true,
    );
  });
});
