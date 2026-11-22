import { randomUUID } from "node:crypto";
import { signAwsRequest } from "@errtraq/aws-signing";
import { bootstrapDeployed, hashApiToken, RecordHandler } from "@errtraq/core";
import { bundleDebugIdsDigest } from "@errtraq/core/store";
import {
  activeStoreContract,
  MemoryBlobStore,
  MemoryKV,
  MemoryQueue,
} from "@errtraq/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { partition } from "./keys.js";
import { DynamoStore } from "./runtime.js";

const endpoint = process.env.ERRTRAQ_DYNAMO_EMULATOR;
if (
  endpoint &&
  (new URL(endpoint).hostname !== "127.0.0.1" ||
    new URL(endpoint).origin !== endpoint)
)
  throw new Error("DynamoDB emulator must be loopback");
const shape: Record<string, unknown> = process.env.ERRTRAQ_DYNAMO_STORE_SHAPE
  ? JSON.parse(process.env.ERRTRAQ_DYNAMO_STORE_SHAPE)
  : {};
const environment = {
  AWS_ACCESS_KEY_ID: "emulator",
  AWS_SECRET_ACCESS_KEY: "emulator",
};
async function api(action: string, input: Record<string, unknown>) {
  if (!endpoint) throw new Error("Missing emulator");
  const body = JSON.stringify(input);
  const signed = await signAwsRequest({
    url: `${endpoint}/`,
    method: "POST",
    body,
    service: "dynamodb",
    region: "us-east-1",
    accessKeyId: environment.AWS_ACCESS_KEY_ID,
    secretAccessKey: environment.AWS_SECRET_ACCESS_KEY,
    headers: {
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": `DynamoDB_20120810.${action}`,
    },
  });
  const response = await fetch(signed.url, {
    method: "POST",
    body,
    headers: signed.headers,
  });
  if (!response.ok)
    throw new Error(`Emulator ${action} failed: ${await response.text()}`);
  return response.json();
}
const tables: string[] = [];
async function makeStore(migrate = true) {
  const table = `errtraq-${randomUUID().replaceAll("-", "")}`;
  await api("CreateTable", { ...shape, TableName: table });
  tables.push(table);
  await api("PutItem", {
    TableName: table,
    Item: {
      PK: { S: "META|schema" },
      SK: { S: "DATA" },
      projectTimeShards: { N: "4" },
    },
  });
  const store = new DynamoStore({
    table,
    region: "us-east-1",
    environment,
    endpoint,
  });
  if (migrate) await store.migrate();
  if (process.env.ERRTRAQ_MEASURE_ISSUE_WRITES === "1") {
    const request = store.request.bind(store);
    let writes = 0,
      completed = 0;
    vi.spyOn(store, "request").mockImplementation(async (action, input) => {
      if (action === "TransactWriteItems") writes++;
      return request(action, input);
    });
    const record = store.recordEvent.bind(store);
    store.recordEvent = async (occurrence, event) => {
      const result = await record(occurrence, event);
      if (++completed === 40)
        console.log(
          `DYNAMODB 40-EVENT CONTRACT: ${writes} transaction attempts, ${(writes / 40).toFixed(2)} attempts/event`,
        );
      return result;
    };
  }
  return store;
}
describe.skipIf(!endpoint)("DynamoDB store emulator", () => {
  afterEach(async () => {
    for (const table of tables.splice(0))
      await api("DeleteTable", { TableName: table });
  });
  activeStoreContract(makeStore);
  it("backfills a legacy bundle index through DynamoDB without scanning", async () => {
    const store = await makeStore();
    const bundle = {
      id: "legacy",
      projectId: "1",
      releaseId: "release",
      state: "pending",
      pendingExpiresAt: "2025-01-01T00:00:00.000Z",
      blobKey: "bundle",
      manifest: { blobKey: "manifest", debugIdCount: 0, digest: "digest" },
    };
    await api("PutItem", {
      TableName: store.table,
      Item: {
        PK: { S: partition("BUNDLE", "1", "legacy") },
        SK: { S: "DATA" },
        data: { S: JSON.stringify(bundle) },
        revision: { S: "legacy" },
      },
    });
    const inventory = [{ projectId: "1", bundleId: "legacy" }];
    expect(await store.backfillBundleIndexes(inventory)).toMatchObject({
      updated: 1,
    });
    expect(await store.backfillBundleIndexes(inventory)).toMatchObject({
      unchanged: 1,
    });
    const result = await api("GetItem", {
      TableName: store.table,
      Key: { PK: { S: partition("BUNDLE", "1", "legacy") }, SK: { S: "DATA" } },
      ConsistentRead: true,
    });
    expect(result.Item.GSI7PK.S).toContain("ENTITY|");
    expect(result.Item.GSI3SK.S).toMatch(/^2025-01-01/);
  });
  it("measures grouped queue contention end to end on DynamoDB Local", async () => {
    for (const total of [200, 500]) {
      const store = await makeStore();
      const request = DynamoStore.prototype.request.bind(store);
      let hotTransactions = 0,
        allTransactions = 0,
        complete = 0,
        failures = 0;
      vi.spyOn(store, "request").mockImplementation(async (action, input) => {
        if (action === "TransactWriteItems") {
          allTransactions++;
          if (JSON.stringify(input).includes("IS|31!|")) hotTransactions++;
        }
        return request(action, input);
      });
      const queue = new MemoryQueue();
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const record = new RecordHandler({
        store,
        blobs: new MemoryBlobStore(),
        logger,
      });
      const active = new Map<string, number>();
      let maximum = 0,
        maxWorkers = 0,
        workersActive = 0;
      const stop = new AbortController();
      const handler: import("@errtraq/core").BatchHandler = async (batch) => {
        const group = batch[0]?.message.groupKey ?? "missing";
        const count = (active.get(group) ?? 0) + 1;
        active.set(group, count);
        maximum = Math.max(maximum, count);
        maxWorkers = Math.max(maxWorkers, ++workersActive);
        try {
          const result = await record.handle(batch);
          complete += result.filter((x) => x.action === "ack").length;
          failures += result.filter((x) => x.action !== "ack").length;
          return result;
        } finally {
          active.set(group, count - 1);
          workersActive--;
        }
      };
      const background = 40;
      const timestamp = "2025-01-01T00:00:00.000Z";
      for (let i = 0; i < total; i++) {
        const eventId = i.toString(16).padStart(32, "0");
        const common = {
          projectId: "1",
          issueId: "hot",
          eventId,
          timestamp,
          receivedAt: timestamp,
        };
        await queue.producer.send("record", [
          {
            key: eventId,
            groupKey: "hot",
            body: {
              version: 1,
              occurrence: {
                ...common,
                fingerprint: "hot",
                title: "test",
                culprit: "",
                level: "error",
                type: "error",
                metadata: {},
              },
              event: { ...common, level: "error", tags: {}, payload: {} },
            },
          },
        ]);
        if (i < background) {
          const other = {
            ...common,
            projectId: "2",
            issueId: `other-${i % 8}`,
            eventId: (i + 10000).toString(16).padStart(32, "0"),
          };
          await queue.producer.send("record", [
            {
              key: other.eventId,
              groupKey: other.issueId,
              body: {
                version: 1,
                occurrence: {
                  ...other,
                  fingerprint: other.issueId,
                  title: "test",
                  culprit: "",
                  level: "error",
                  type: "error",
                  metadata: {},
                },
                event: { ...other, level: "error", tags: {}, payload: {} },
              },
            },
          ]);
        }
      }
      const start = performance.now();
      const workers = Array.from({ length: 4 }, () =>
        queue.pull.run(handler, stop.signal),
      );
      try {
        const deadline = Date.now() + 120000;
        while (complete < total + background && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        expect(complete).toBe(total + background);
      } finally {
        stop.abort();
        await Promise.all(workers);
      }
      const elapsed = (performance.now() - start) / 1000;
      expect(failures).toBe(0);
      expect(maximum).toBe(1);
      expect(maxWorkers).toBeGreaterThan(1);
      expect(hotTransactions).toBeGreaterThanOrEqual(total);
      expect(
        (
          await store.issues.get(
            "1" as import("@errtraq/core").ProjectId,
            "hot" as import("@errtraq/core").IssueId,
          )
        )?.count,
      ).toBe(total);
      console.log(
        `GROUPED QUEUE END-TO-END: hot=${total}, background=${background}, hot transactions=${hotTransactions}, all transactions=${allTransactions}, hot transactions/event=${(hotTransactions / total).toFixed(2)}, max group concurrency=${maximum}, max workers=${maxWorkers}, drain=${elapsed.toFixed(2)}s, retries=${failures}`,
      );
    }
  }, 240000);
  it("measures issue-grouped writes on DynamoDB Local", async () => {
    for (const total of [200, 500]) {
      const store = await makeStore();
      const request = DynamoStore.prototype.request.bind(store);
      let transactions = 0;
      vi.spyOn(store, "request").mockImplementation(async (action, input) => {
        if (action === "TransactWriteItems") transactions++;
        return request(action, input);
      });
      const projectId = "benchmark" as import("@errtraq/core").ProjectId;
      const issueId = "issue" as import("@errtraq/core").IssueId;
      const receivedAt =
        "2025-01-01T00:00:00.000Z" as import("@errtraq/core").Timestamp;
      for (let start = 0; start < total; start += 10) {
        const group = Array.from({ length: 10 }, (_, n) => {
          const eventId =
            `event-${start + n}` as import("@errtraq/core").EventId;
          const common = {
            projectId,
            issueId,
            eventId,
            timestamp: receivedAt,
            receivedAt,
          };
          return {
            occurrence: {
              ...common,
              fingerprint: "fp",
              title: "test",
              culprit: "",
              level: "error" as const,
              type: "error",
              metadata: {},
            },
            event: {
              ...common,
              level: "error" as const,
              tags: {},
              payload: {},
            },
          };
        });
        await store.recordEvents(group);
      }
      expect((await store.issues.get(projectId, issueId))?.count).toBe(total);
      console.log(
        `GROUPED DYNAMODB LOCAL: ${total} events, ${transactions} transactions, ${(transactions / total).toFixed(2)} transactions/event`,
      );
      expect(transactions).toBe(total / 10);
    }
  }, 60000);
  it("bootstraps a DynamoDB store concurrently without prior migration", async () => {
    const store = await makeStore(false);
    const kv = new MemoryKV();
    let secret: string | undefined;
    const vault = {
      async claim(_name: string, candidate: string) {
        secret ??= candidate;
        return { identifier: "arn:bootstrap", value: secret };
      },
    };
    const options = {
      stackName: "stack",
      store,
      kv,
      vault,
      secretName: "bootstrap",
      ingestUrl: "https://ingest.example/",
      orgSlug: "org",
      projectSlug: "project",
    };
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () => bootstrapDeployed(options)),
      ),
    ).toEqual(Array(4).fill("arn:bootstrap"));
    const saved = JSON.parse(secret ?? "null");
    expect(
      await store.projects.getTokenByHash(await hashApiToken(saved.token)),
    ).toMatchObject({ orgId: saved.orgId });
  });
  it("measures forty concurrent writes without treating emulator atomicity as proof", async () => {
    const store = await makeStore();
    const request = store.request.bind(store);
    let transactions = 0;
    vi.spyOn(store, "request").mockImplementation(async (action, input) => {
      if (action === "TransactWriteItems") transactions++;
      return request(action, input);
    });
    const projectId = "benchmark" as import("@errtraq/core").ProjectId;
    const issueId = "issue" as import("@errtraq/core").IssueId;
    const receivedAt =
      "2025-01-01T00:00:00.000Z" as import("@errtraq/core").Timestamp;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 40 }, (_, n) => {
        const eventId = `event-${n}` as import("@errtraq/core").EventId;
        return store.recordEvent(
          {
            projectId,
            issueId,
            eventId,
            timestamp: receivedAt,
            receivedAt,
            fingerprint: "fp",
            title: "test",
            culprit: "",
            level: "error",
            type: "error",
            metadata: {},
          },
          {
            projectId,
            issueId,
            eventId,
            timestamp: receivedAt,
            receivedAt,
            level: "error",
            tags: {},
            payload: {},
          },
        );
      }),
    );
    const succeeded = outcomes.filter(
      (outcome) => outcome.status === "fulfilled",
    ).length;
    console.log(
      `WINTERBAUME #61 DIAGNOSTIC: ${transactions} transaction attempts / 40 events (${(transactions / 40).toFixed(2)} per event); ${succeeded} fulfilled, ${40 - succeeded} failed; not an atomicity assertion`,
    );
    expect(outcomes).toHaveLength(40);
  }, 30000);
  it("resumes an interrupted active bundle deletion from strongly read chunks", async () => {
    const store = await makeStore();
    const ids = Array.from({ length: 150 }, (_, i) => `debug-${i}`);
    const project = "project" as import("@errtraq/core").ProjectId;
    const bundle = {
      id: "bundle" as import("@errtraq/core").ArtifactBundleId,
      projectId: project,
      releaseId: "release" as import("@errtraq/core").ReleaseId,
      blobKey: "bundle",
      state: "pending" as const,
      pendingExpiresAt:
        "2099-01-01T00:00:00.000Z" as import("@errtraq/core").Timestamp,
      manifest: {
        blobKey: "manifest",
        debugIdCount: ids.length,
        digest: await bundleDebugIdsDigest(ids),
      },
    };
    await store.releases.beginBundle(bundle, bundle.manifest);
    await store.releases.putBundleDebugIds(
      project,
      bundle.id,
      ids.slice(0, 100),
      ids,
    );
    await store.releases.putBundleDebugIds(
      project,
      bundle.id,
      ids.slice(100),
      ids,
    );
    await store.releases.verifyAndActivateBundle(project, bundle.id, ids);
    const request = store.request.bind(store);
    let deletions = 0;
    const spy = vi
      .spyOn(store, "request")
      .mockImplementation(async (action, input) => {
        if (
          action === "TransactWriteItems" &&
          JSON.stringify(input).includes('"Delete"') &&
          ++deletions === 2
        )
          throw new Error("injected interruption");
        return request(action, input);
      });
    await expect(
      store.releases.deleteBundle(project, bundle.id),
    ).rejects.toThrow("injected interruption");
    expect(
      await store.releases.findBundleByDebugId(project, ids[149] as string),
    ).toBeNull();
    spy.mockRestore();
    await store.releases.deleteBundle(project, bundle.id);
    const replacement = { ...bundle, id: "replacement" as typeof bundle.id };
    await store.releases.beginBundle(replacement, replacement.manifest);
    await store.releases.putBundleDebugIds(
      project,
      replacement.id,
      ids.slice(0, 100),
      ids,
    );
    await store.releases.putBundleDebugIds(
      project,
      replacement.id,
      ids.slice(100),
      ids,
    );
    await store.releases.verifyAndActivateBundle(project, replacement.id, ids);
    expect(
      (await store.releases.findBundleByDebugId(project, ids[149] as string))
        ?.id,
    ).toBe(replacement.id);
  });
});
