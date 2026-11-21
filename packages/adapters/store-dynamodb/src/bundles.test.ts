import type { ArtifactBundle } from "@errtraq/core";
import { bundleDebugIdsDigest, ConflictError } from "@errtraq/core/store";
import { expect, it } from "vitest";
import { bundleRepository } from "./bundles.js";
import { DynamoTransactionCanceledError } from "./errors.js";
import type { Driver } from "./repository-base.js";

it.each(["TransactionConflict", "ThrottlingError"])(
  "retries %s and indexes pending bundles by release and expiry",
  async (code) => {
    const requests: { action: string; input: Record<string, unknown> }[] = [];
    let attempts = 0;
    const request: Driver["request"] = async (action, input) => {
      requests.push({ action, input });
      if (action === "GetItem") return {};
      if (action === "TransactWriteItems" && ++attempts === 1)
        throw new DynamoTransactionCanceledError([{ code }]);
      return {};
    };
    const bundle = {
      id: "bundle",
      projectId: "project",
      releaseId: "release",
      state: "pending",
      blobKey: "key",
      pendingExpiresAt: "2025-01-01T00:00:00.000Z",
      manifest: { debugIdCount: 0, digest: "digest" },
    } as ArtifactBundle;
    const repo = bundleRepository({ table: "table", request });
    await repo.beginBundle(bundle, bundle.manifest);
    await expect(
      repo.beginBundle(
        {
          ...bundle,
          pendingExpiresAt: "2025-01-01T00:00:00Z" as NonNullable<
            ArtifactBundle["pendingExpiresAt"]
          >,
        },
        bundle.manifest,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(attempts).toBe(2);
    const write = requests.find(
      (entry) => entry.action === "TransactWriteItems",
    )?.input as {
      TransactItems: {
        Put: { Item: Record<string, { S?: string; N?: string }> };
      }[];
    };
    const item = write.TransactItems[0]?.Put.Item;
    expect(item?.GSI7PK?.S).toContain("72656c65617365");
    expect(item?.GSI3SK?.S).toMatch(/^2025-01-01/);

    await repo.listPendingBundles(
      bundle.projectId,
      bundle.pendingExpiresAt as NonNullable<
        ArtifactBundle["pendingExpiresAt"]
      >,
    );
    expect(requests.at(-1)).toMatchObject({
      action: "Query",
      input: {
        IndexName: "issue-id",
        KeyConditionExpression: "#pk = :pk AND #sk <= :upper",
      },
    });
  },
);

it("re-reads a stale bundle guard while preserving genuine ownership conflicts", async () => {
  const ids = ["debug"];
  const bundle = {
    id: "bundle",
    projectId: "project",
    releaseId: "release",
    state: "pending",
    blobKey: "key",
    pendingExpiresAt: "2025-01-01T00:00:00.000Z",
    manifest: { debugIdCount: 1, digest: await bundleDebugIdsDigest(ids) },
  } as ArtifactBundle;
  let writes = 0;
  let markerConflict = false;
  const request: Driver["request"] = async (action) => {
    if (action === "GetItem")
      return {
        Item: {
          data: { S: JSON.stringify(bundle) },
          generation: { S: "generation" },
          revision: { S: `revision-${writes}` },
        },
      };
    writes++;
    if (markerConflict)
      throw new DynamoTransactionCanceledError([
        { code: "None" },
        { code: "None" },
        { code: "ConditionalCheckFailed" },
      ]);
    if (writes === 1)
      throw new DynamoTransactionCanceledError([
        { code: "ConditionalCheckFailed" },
        { code: "None" },
        { code: "None" },
      ]);
    return {};
  };
  const repo = bundleRepository({ table: "table", request });
  await repo.putBundleDebugIds(bundle.projectId, bundle.id, ids, ids);
  expect(writes).toBe(2);
  markerConflict = true;
  await expect(
    repo.putBundleDebugIds(bundle.projectId, bundle.id, ids, ids),
  ).rejects.toBeInstanceOf(ConflictError);
});

it("finishes cleanup with one conditional DeleteItem", async () => {
  const bundle = {
    id: "bundle",
    projectId: "project",
    state: "pending",
    cleanupMarkersCleared: true,
    cleanupId: "cleanup",
  } as ArtifactBundle;
  const actions: string[] = [];
  const request: Driver["request"] = async (action, input) => {
    actions.push(action);
    if (action === "GetItem")
      return {
        Item: {
          data: { S: JSON.stringify(bundle) },
          revision: { S: "revision" },
        },
      };
    expect(input).toMatchObject({ ConditionExpression: "#rev = :rev" });
    return {};
  };
  await bundleRepository({
    table: "table",
    request,
  }).finishPendingBundleCleanup(bundle.projectId, bundle.id, "cleanup");
  expect(actions).toEqual(["GetItem", "DeleteItem"]);
});
