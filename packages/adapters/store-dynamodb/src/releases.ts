import type { Release, ReleaseRepo } from "@errtraq/core";
import { partition, sortKey } from "./keys.js";
import { indexPartition, markerLookup, writeUnique } from "./projects.js";
import { type Driver, get, itemData, pageIndex } from "./repository-base.js";

const unimplemented = async (): Promise<never> => {
  throw new Error("DynamoDB bundle lifecycle is not implemented");
};
const releaseKey = (projectId: string, id: string) =>
  partition("REL", projectId, id);
const versionKey = (projectId: string, version: string) =>
  partition("RELEASE", projectId, version);
export function releaseRepository(driver: Driver): ReleaseRepo {
  return {
    get: async (projectId, id) =>
      itemData<Release>(await get(driver, releaseKey(projectId, id))),
    getReleaseByVersion: (projectId, version) =>
      markerLookup<Release>(driver, versionKey(projectId, version)),
    put: (release) =>
      writeUnique(
        driver,
        releaseKey(release.projectId, release.id),
        release,
        versionKey(release.projectId, release.version),
        (old) => versionKey(old.projectId, old.version),
        {
          partition: indexPartition("releases", release.projectId),
          sort: sortKey(release.id),
        },
      ),
    list: (projectId, cursor, limit) =>
      pageIndex<Release>(
        driver,
        "entity-list",
        "GSI7PK",
        "GSI7SK",
        indexPartition("releases", projectId),
        JSON.stringify(["releases", projectId]),
        cursor,
        limit,
      ),
    beginBundle: unimplemented,
    putBundleDebugIds: unimplemented,
    verifyAndActivateBundle: unimplemented,
    listPendingBundles: unimplemented,
    claimPendingBundleCleanup: unimplemented,
    clearPendingBundleDebugIds: unimplemented,
    finishPendingBundleCleanup: unimplemented,
    listBundles: unimplemented,
    deleteBundle: unimplemented,
    findBundleByDebugId: unimplemented,
  };
}
