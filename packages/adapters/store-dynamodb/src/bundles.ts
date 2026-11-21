import type { ArtifactBundle, ReleaseRepo } from "@errtraq/core";
import { bundleDebugIdsDigest, ConflictError } from "@errtraq/core/store";
import { partition, sortKey } from "./keys.js";
import { indexPartition } from "./projects.js";
import {
  cancelled,
  conditionFor,
  type Driver,
  dataItem,
  get,
  type Item,
  itemData,
  pageIndex,
  primary,
  s,
} from "./repository-base.js";

const bundleKey = (project: string, id: string) =>
  partition("BUNDLE", project, id);
const debugKey = (project: string, id: string) =>
  partition("DEBUG", project, id);
const failed = (): never => {
  throw new ConflictError("Bundle lifecycle conflict");
};
const index = (bundle: ArtifactBundle) => ({
  partition: indexPartition("bundles", bundle.projectId),
  sort: sortKey(bundle.id),
});
type State = { item: Item; bundle: ArtifactBundle };
async function state(d: Driver, key: string): Promise<State | null> {
  const item = await get(d, key);
  const bundle = itemData<ArtifactBundle>(item);
  return item && bundle ? { item, bundle } : null;
}
function bundlePut(
  d: Driver,
  key: string,
  old: Item | undefined,
  bundle: ArtifactBundle,
  deleting = false,
) {
  return {
    Put: {
      TableName: d.table,
      Item: {
        ...dataItem(key, bundle, deleting ? undefined : index(bundle)),
        generation: old?.generation ?? s(crypto.randomUUID()),
        ...(deleting ? { deleting: s("1") } : {}),
      },
      ...conditionFor(old),
    },
  };
}
async function transact(d: Driver, writes: object[]) {
  try {
    await d.request("TransactWriteItems", { TransactItems: writes });
  } catch (e) {
    if (cancelled(e)) failed();
    throw e;
  }
}
async function valid(bundle: ArtifactBundle, ids: readonly string[]) {
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== bundle.manifest.debugIdCount ||
    (await bundleDebugIdsDigest(ids)) !== bundle.manifest.digest
  )
    failed();
}
async function readMarkers(
  d: Driver,
  project: string,
  ids: readonly string[],
): Promise<Map<string, Item>> {
  const found = new Map<string, Item>();
  for (let offset = 0; offset < ids.length; offset += 100) {
    let keys = ids
      .slice(offset, offset + 100)
      .map((id) => primary(debugKey(project, id)));
    for (let attempt = 0; keys.length && attempt < 10; attempt++) {
      const result = await d.request("BatchGetItem", {
        RequestItems: { [d.table]: { Keys: keys, ConsistentRead: true } },
      });
      const responses = result.Responses as Record<string, Item[]> | undefined;
      for (const item of responses?.[d.table] ?? [])
        if (item.PK?.S) found.set(item.PK.S, item);
      const pending = result.UnprocessedKeys as
        | Record<string, { Keys?: typeof keys }>
        | undefined;
      keys = pending?.[d.table]?.Keys ?? [];
      if (keys.length)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * Math.min(250, 10 * 2 ** attempt)),
        );
    }
    if (keys.length) throw new Error("Unable to read bundle ownership markers");
  }
  return found;
}
async function removeChunks(
  d: Driver,
  key: string,
  project: string,
  generation: string,
) {
  for (;;) {
    const result = await d.request("Query", {
      TableName: d.table,
      ConsistentRead: true,
      Limit: 1,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": s(key), ":sk": s("CHUNK|") },
    });
    const chunk = (result.Items as Item[] | undefined)?.[0];
    if (!chunk) return;
    const ids = itemData<string[]>(chunk);
    if (!ids) throw new Error("Invalid bundle chunk");
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = await state(d, key);
      if (
        !current ||
        current.item.generation?.S !== generation ||
        (!current.item.deleting && !current.bundle.cleanupStarted)
      )
        return failed();
      const markers = await readMarkers(d, project, ids);
      const owned = ids.filter(
        (id) =>
          markers.get(debugKey(project, id))?.owner?.S === key &&
          markers.get(debugKey(project, id))?.generation?.S === generation,
      );
      const writes: object[] = [
        bundlePut(
          d,
          key,
          current.item,
          current.bundle,
          !!current.item.deleting,
        ),
        ...owned.map((id) => ({
          Delete: {
            TableName: d.table,
            Key: primary(debugKey(project, id)),
            ConditionExpression: "#owner = :owner AND #gen = :gen",
            ExpressionAttributeNames: {
              "#owner": "owner",
              "#gen": "generation",
            },
            ExpressionAttributeValues: {
              ":owner": s(key),
              ":gen": s(generation),
            },
          },
        })),
      ];
      writes.push({
        Delete: { TableName: d.table, Key: primary(key, chunk.SK?.S) },
      });
      try {
        await d.request("TransactWriteItems", { TransactItems: writes });
        break;
      } catch (error) {
        if (!cancelled(error) || attempt === 11) throw error;
      }
    }
  }
}
export function bundleRepository(
  d: Driver,
): Pick<
  ReleaseRepo,
  | "beginBundle"
  | "putBundleDebugIds"
  | "verifyAndActivateBundle"
  | "listPendingBundles"
  | "claimPendingBundleCleanup"
  | "clearPendingBundleDebugIds"
  | "finishPendingBundleCleanup"
  | "listBundles"
  | "deleteBundle"
  | "findBundleByDebugId"
> {
  return {
    async beginBundle(bundle, manifest) {
      if (
        bundle.state !== "pending" ||
        !bundle.pendingExpiresAt ||
        !Number.isFinite(Date.parse(bundle.pendingExpiresAt)) ||
        JSON.stringify(bundle.manifest) !== JSON.stringify(manifest)
      )
        failed();
      const key = bundleKey(bundle.projectId, bundle.id);
      const old = await state(d, key);
      if (old) {
        if (
          JSON.stringify(old.bundle) !== JSON.stringify(bundle) ||
          old.item.deleting
        )
          failed();
        return;
      }
      await transact(d, [bundlePut(d, key, undefined, bundle)]);
    },
    async putBundleDebugIds(project, id, ids, manifestIds) {
      const key = bundleKey(project, id);
      const old = await state(d, key);
      if (
        !old?.item.generation?.S ||
        old.bundle.state !== "pending" ||
        old.bundle.cleanupStarted ||
        old.item.deleting
      )
        return failed();
      await valid(old.bundle, manifestIds);
      const expected = new Set(manifestIds);
      if (ids.length > 100 || ids.some((x) => !expected.has(x))) failed();
      const unique = [...new Set(ids)];
      for (let i = 0; i < unique.length; i += 98) {
        const group = unique.slice(i, i + 98);
        const current = await state(d, key);
        if (
          !current ||
          current.item.generation?.S !== old.item.generation?.S ||
          current.bundle.state !== "pending" ||
          current.bundle.cleanupStarted ||
          current.item.deleting
        )
          return failed();
        const digest = await bundleDebugIdsDigest(group);
        const writes: object[] = [
          bundlePut(d, key, current.item, current.bundle),
          {
            Put: {
              TableName: d.table,
              Item: {
                ...primary(key, `CHUNK|${digest}`),
                data: s(JSON.stringify(group)),
              },
            },
          },
        ];
        for (const debug of group)
          writes.push({
            Put: {
              TableName: d.table,
              Item: {
                ...primary(debugKey(project, debug)),
                owner: s(key),
                generation: current.item.generation,
                ttlEpoch: {
                  N: String(
                    Math.floor(
                      Date.parse(current.bundle.pendingExpiresAt as string) /
                        1000,
                    ),
                  ),
                },
              },
              ConditionExpression:
                "attribute_not_exists(PK) OR (#owner = :owner AND #gen = :gen)",
              ExpressionAttributeNames: {
                "#owner": "owner",
                "#gen": "generation",
              },
              ExpressionAttributeValues: {
                ":owner": s(key),
                ":gen": current.item.generation,
              },
            },
          });
        await transact(d, writes);
      }
    },
    async verifyAndActivateBundle(project, id, ids) {
      const key = bundleKey(project, id);
      let old = await state(d, key);
      if (!old || old.bundle.cleanupStarted || old.item.deleting)
        return failed();
      await valid(old.bundle, ids);
      const generation = old.item.generation?.S;
      if (!generation) return failed();
      const markers = await readMarkers(d, project, ids);
      if (
        ids.some(
          (debug) =>
            markers.get(debugKey(project, debug))?.owner?.S !== key ||
            markers.get(debugKey(project, debug))?.generation?.S !== generation,
        )
      )
        failed();
      if (old.bundle.state === "active") return;
      for (let offset = 0; offset < ids.length; offset += 99) {
        old = await state(d, key);
        if (
          !old ||
          old.item.generation?.S !== generation ||
          old.bundle.state !== "pending" ||
          old.bundle.cleanupStarted ||
          old.item.deleting
        )
          return failed();
        const writes: object[] = [bundlePut(d, key, old.item, old.bundle)];
        for (const debug of ids.slice(offset, offset + 99))
          writes.push({
            Update: {
              TableName: d.table,
              Key: primary(debugKey(project, debug)),
              UpdateExpression: "REMOVE ttlEpoch",
              ConditionExpression: "#owner = :owner AND #gen = :gen",
              ExpressionAttributeNames: {
                "#owner": "owner",
                "#gen": "generation",
              },
              ExpressionAttributeValues: {
                ":owner": s(key),
                ":gen": s(generation),
              },
            },
          });
        await transact(d, writes);
      }
      old = await state(d, key);
      if (
        !old ||
        old.item.generation?.S !== generation ||
        old.bundle.state !== "pending" ||
        old.bundle.cleanupStarted ||
        old.item.deleting
      )
        return failed();
      const bundle = { ...old.bundle, state: "active" as const };
      delete bundle.pendingExpiresAt;
      await transact(d, [bundlePut(d, key, old.item, bundle)]);
    },
    async listPendingBundles(project, before, cursor, limit) {
      const page = await pageIndex<ArtifactBundle>(
        d,
        "entity-list",
        "GSI7PK",
        "GSI7SK",
        indexPartition("bundles", project),
        JSON.stringify(["pending-bundles", project, before]),
        cursor,
        limit,
      );
      return {
        ...page,
        items: page.items.filter(
          (x) =>
            x.state === "pending" &&
            !!x.pendingExpiresAt &&
            x.pendingExpiresAt <= before,
        ),
      };
    },
    async claimPendingBundleCleanup(project, id, before) {
      const key = bundleKey(project, id);
      const old = await state(d, key);
      if (
        old?.bundle.state !== "pending" ||
        !old.bundle.pendingExpiresAt ||
        old.bundle.pendingExpiresAt > before ||
        old.item.deleting
      )
        return null;
      if (old.bundle.cleanupStarted) return old.bundle;
      const bundle = {
        ...old.bundle,
        cleanupStarted: true,
        cleanupId: crypto.randomUUID(),
      };
      await transact(d, [bundlePut(d, key, old.item, bundle)]);
      return bundle;
    },
    async clearPendingBundleDebugIds(project, id, ids, cleanupId) {
      const key = bundleKey(project, id);
      const old = await state(d, key);
      if (
        old?.bundle.state !== "pending" ||
        !old.bundle.cleanupStarted ||
        old.bundle.cleanupId !== cleanupId
      )
        return failed();
      if (old.bundle.cleanupMarkersCleared) return;
      await valid(old.bundle, ids);
      const generation = old.item.generation?.S;
      if (!generation) return failed();
      await removeChunks(d, key, project, generation);
      const current = await state(d, key);
      if (!current || current.bundle.cleanupId !== cleanupId) return failed();
      await transact(d, [
        bundlePut(d, key, current.item, {
          ...current.bundle,
          cleanupMarkersCleared: true,
        }),
      ]);
    },
    async finishPendingBundleCleanup(project, id, cleanupId) {
      const key = bundleKey(project, id);
      const old = await state(d, key);
      if (!old) return;
      if (
        old.bundle.state !== "pending" ||
        !old.bundle.cleanupMarkersCleared ||
        old.bundle.cleanupId !== cleanupId
      )
        return failed();
      await transact(d, [
        {
          Delete: {
            TableName: d.table,
            Key: primary(key),
            ...conditionFor(old.item),
          },
        },
      ]);
    },
    async listBundles(project, release, cursor, limit) {
      const page = await pageIndex<ArtifactBundle>(
        d,
        "entity-list",
        "GSI7PK",
        "GSI7SK",
        indexPartition("bundles", project),
        JSON.stringify(["bundles", project, release]),
        cursor,
        limit,
      );
      return {
        ...page,
        items: page.items.filter((x) => x.releaseId === release),
      };
    },
    async deleteBundle(project, id) {
      const key = bundleKey(project, id);
      let old = await state(d, key);
      if (!old) return;
      if (old.bundle.state === "pending") return failed();
      const generation = old.item.generation?.S;
      if (!generation) return failed();
      if (!old.item.deleting) {
        await transact(d, [bundlePut(d, key, old.item, old.bundle, true)]);
        old = await state(d, key);
      }
      if (!old || old.item.generation?.S !== generation) return;
      await removeChunks(d, key, project, generation);
      old = await state(d, key);
      if (old && old.item.generation?.S === generation)
        await transact(d, [
          {
            Delete: {
              TableName: d.table,
              Key: primary(key),
              ...conditionFor(old.item),
            },
          },
        ]);
    },
    async findBundleByDebugId(project, id) {
      const marker = await get(d, debugKey(project, id));
      if (!marker?.owner?.S) return null;
      const found = await state(d, marker.owner.S);
      return found &&
        found.bundle.state === "active" &&
        !found.item.deleting &&
        marker.generation?.S === found.item.generation?.S
        ? found.bundle
        : null;
    },
  };
}
