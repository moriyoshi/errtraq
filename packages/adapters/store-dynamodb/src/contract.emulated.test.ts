import { randomUUID } from "node:crypto";
import { signAwsRequest } from "@errtraq/aws-signing";
import { bundleDebugIdsDigest } from "@errtraq/core/store";
import { activeStoreContract } from "@errtraq/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
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
async function makeStore() {
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
  await store.migrate();
  return store;
}
describe.skipIf(!endpoint)("DynamoDB store emulator", () => {
  afterEach(async () => {
    for (const table of tables.splice(0))
      await api("DeleteTable", { TableName: table });
  });
  activeStoreContract(makeStore);
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
