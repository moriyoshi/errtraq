import type {
  ArtifactBundle,
  Release,
  ReleaseRepo,
} from "@moriyoshi/errtraq-core";
import {
  bundleDebugIdsDigest,
  ConflictError,
} from "@moriyoshi/errtraq-core/store";
import {
  encodeFields,
  type FirestoreClient,
  NAME_FIELD,
  type Query,
  type RawDocument,
  type Write,
} from "@moriyoshi/errtraq-firestore-rest";
import {
  canonical,
  commitChunked,
  create,
  entityData,
  entityFields,
  field,
  leaf,
  naturalKey,
  pageQuery,
  remove,
  segment,
  set,
} from "./base.js";

const projectParent = (projectId: string) => `projects/${segment(projectId)}`;
const releasePath = (projectId: string, id: string) =>
  `${projectParent(projectId)}/releases/${segment(id)}`;
const bundlePath = (projectId: string, id: string) =>
  `${projectParent(projectId)}/bundles/${segment(id)}`;
const debugIdPath = async (projectId: string, debugId: string) =>
  `${projectParent(projectId)}/debugIds/${await naturalKey("debug-id", debugId)}`;
const versionMarker = async (projectId: string, version: string) =>
  `markers/release|${await naturalKey("release", projectId, version)}`;
const eq = (name: string, value: string) => ({
  field: name,
  op: "EQUAL" as const,
  value: { stringValue: value },
});

function bundleFields(bundle: ArtifactBundle) {
  return entityFields(
    {
      releaseId: bundle.releaseId,
      state: bundle.state,
      // Absent once active, which drops the bundle from the pending index.
      ...(bundle.pendingExpiresAt
        ? { pendingExpiresAt: bundle.pendingExpiresAt }
        : {}),
    },
    bundle,
  );
}
const markerFields = (projectId: string, bundleId: string, debugId: string) =>
  encodeFields({ bundleId, projectId, debugId });
const markerBundle = (doc: RawDocument | null) => {
  const value = doc ? field(doc, "bundleId") : undefined;
  return typeof value === "string" ? value : undefined;
};
const DEBUG_ID_CHUNK = 100;

export function releaseRepository(client: FirestoreClient): ReleaseRepo {
  const readBundle = async (projectId: string, bundleId: string) => {
    const doc = await client.get(bundlePath(projectId, bundleId));
    return doc ? entityData<ArtifactBundle>(doc) : null;
  };
  /** Every marker owned by the bundle, paged by query (no table scan). */
  async function ownedMarkers(
    projectId: string,
    bundleId: string,
  ): Promise<RawDocument[]> {
    const found: RawDocument[] = [];
    let after: string | undefined;
    for (;;) {
      const query: Query = {
        parent: projectParent(projectId),
        collection: "debugIds",
        where: [eq("bundleId", bundleId)],
        orderBy: [{ field: NAME_FIELD, direction: "ASC" }],
        ...(after
          ? {
              startAfter: [
                { docPath: `${projectParent(projectId)}/debugIds/${after}` },
              ],
            }
          : {}),
        limit: 500,
      };
      const page = await client.runQuery(query);
      found.push(...page);
      const last = page.at(-1);
      if (page.length < 500 || !last) return found;
      after = leaf(last.path);
    }
  }
  return {
    get: async (projectId, id) => {
      const doc = await client.get(releasePath(projectId, id));
      return doc ? entityData<Release>(doc) : null;
    },
    getReleaseByVersion: async (projectId, version) => {
      const marker = await client.get(await versionMarker(projectId, version));
      const id = marker ? field(marker, "owner") : undefined;
      if (typeof id !== "string") return null;
      const doc = await client.get(releasePath(projectId, id));
      return doc ? entityData<Release>(doc) : null;
    },
    put: async (release) => {
      const path = releasePath(release.projectId, release.id);
      const marker = await versionMarker(release.projectId, release.version);
      await client.runTransaction(async (tx) => {
        const [existing, owner] = await tx.batchGet([path, marker]);
        const ownerId = owner ? field(owner, "owner") : undefined;
        if (owner && ownerId !== release.id)
          throw new ConflictError("Release version exists");
        const writes: Write[] = [];
        if (existing) {
          const old = entityData<Release>(existing);
          if (old.version !== release.version)
            writes.push(
              remove(await versionMarker(old.projectId, old.version)),
            );
        }
        writes.push(
          set(path, entityFields({ version: release.version }, release)),
          set(marker, encodeFields({ owner: release.id })),
        );
        await tx.commit(writes);
      });
    },
    list: (projectId, cursor, limit) =>
      pageQuery(client, {
        query: {
          parent: projectParent(projectId),
          collection: "releases",
          orderBy: [{ field: NAME_FIELD, direction: "ASC" }],
        },
        scope: JSON.stringify(["releases", projectId]),
        cursor,
        limit,
        read: entityData<Release>,
      }),
    getBundle: (projectId, bundleId) => readBundle(projectId, bundleId),

    beginBundle: async (bundle, manifest) => {
      if (
        bundle.state !== "pending" ||
        !bundle.pendingExpiresAt ||
        canonical(bundle.manifest) !== canonical(manifest)
      )
        throw new ConflictError("Invalid pending bundle");
      const path = bundlePath(bundle.projectId, bundle.id);
      await client.runTransaction(async (tx) => {
        const old = await tx.get(path);
        if (old) {
          if (canonical(entityData<ArtifactBundle>(old)) !== canonical(bundle))
            throw new ConflictError("Bundle already exists");
          return;
        }
        await tx.commit([create(path, bundleFields(bundle))]);
      });
    },

    putBundleDebugIds: async (projectId, bundleId, ids, manifestIds) => {
      const digest = await bundleDebugIdsDigest(manifestIds);
      const path = bundlePath(projectId, bundleId);
      const markers = await Promise.all(
        ids.map((id) => debugIdPath(projectId, id)),
      );
      await client.runTransaction(async (tx) => {
        const [doc, ...existing] = await tx.batchGet([path, ...markers]);
        const bundle = doc ? entityData<ArtifactBundle>(doc) : undefined;
        if (bundle?.state !== "pending" || bundle.cleanupStarted)
          throw new ConflictError("Bundle is not pending");
        const expected = new Set(manifestIds);
        if (
          ids.length > DEBUG_ID_CHUNK ||
          expected.size !== manifestIds.length ||
          manifestIds.length !== bundle.manifest.debugIdCount ||
          digest !== bundle.manifest.digest ||
          ids.some((id) => !expected.has(id))
        )
          throw new ConflictError("Chunk does not match bundle manifest");
        const writes: Write[] = [];
        existing.forEach((marker, i) => {
          const owner = markerBundle(marker);
          if (owner !== undefined && owner !== bundleId)
            throw new ConflictError("Debug ID already owned");
          if (owner === undefined)
            writes.push(
              create(
                markers[i] as string,
                markerFields(projectId, bundleId, ids[i] as string),
              ),
            );
        });
        // The bundle document was read, so a concurrent cleanup claim aborts this commit.
        await tx.commit(writes);
      });
    },

    verifyAndActivateBundle: async (projectId, bundleId, ids) => {
      const path = bundlePath(projectId, bundleId);
      const markers = await Promise.all(
        ids.map((id) => debugIdPath(projectId, id)),
      );
      await client.runTransaction(async (tx) => {
        const doc = await tx.get(path);
        const bundle = doc ? entityData<ArtifactBundle>(doc) : undefined;
        if (!bundle || bundle.cleanupStarted)
          throw new ConflictError("Bundle not found or being cleaned");
        if (
          new Set(ids).size !== ids.length ||
          ids.length !== bundle.manifest.debugIdCount ||
          (await bundleDebugIdsDigest(ids)) !== bundle.manifest.digest
        )
          throw new ConflictError("Bundle manifest does not match markers");
        for (let i = 0; i < markers.length; i += DEBUG_ID_CHUNK) {
          const found = await tx.batchGet(markers.slice(i, i + DEBUG_ID_CHUNK));
          if (found.some((m) => markerBundle(m) !== bundleId))
            throw new ConflictError("Bundle manifest does not match markers");
        }
        if (bundle.state === "active") return;
        const { pendingExpiresAt: _expiry, ...rest } = bundle;
        await tx.commit([
          set(path, bundleFields({ ...rest, state: "active" })),
        ]);
      });
    },

    listPendingBundles: (projectId, before, cursor, limit) =>
      pageQuery(client, {
        query: {
          parent: projectParent(projectId),
          collection: "bundles",
          where: [
            eq("state", "pending"),
            {
              field: "pendingExpiresAt",
              op: "LESS_THAN_OR_EQUAL",
              value: { stringValue: before },
            },
          ],
          orderBy: [
            { field: "pendingExpiresAt", direction: "ASC" },
            { field: NAME_FIELD, direction: "ASC" },
          ],
        },
        scope: JSON.stringify(["pending-bundles", projectId, before]),
        cursor,
        limit,
        read: entityData<ArtifactBundle>,
      }),

    claimPendingBundleCleanup: async (projectId, bundleId, before) => {
      const path = bundlePath(projectId, bundleId);
      return client.runTransaction(async (tx) => {
        const doc = await tx.get(path);
        const bundle = doc ? entityData<ArtifactBundle>(doc) : undefined;
        if (
          bundle?.state !== "pending" ||
          !bundle.pendingExpiresAt ||
          bundle.pendingExpiresAt > before
        )
          return null;
        const claimed: ArtifactBundle = {
          ...bundle,
          cleanupStarted: true,
          cleanupId: bundle.cleanupId ?? crypto.randomUUID(),
        };
        await tx.commit([set(path, bundleFields(claimed))]);
        return claimed;
      });
    },

    clearPendingBundleDebugIds: async (projectId, bundleId, ids, cleanupId) => {
      const path = bundlePath(projectId, bundleId);
      const claim = async (): Promise<ArtifactBundle> => {
        const bundle = await readBundle(projectId, bundleId);
        if (
          bundle?.state !== "pending" ||
          !bundle.cleanupStarted ||
          bundle.cleanupId !== cleanupId
        )
          throw new ConflictError("Bundle cleanup not claimed");
        return bundle;
      };
      const bundle = await claim();
      if (bundle.cleanupMarkersCleared) return;
      if (
        ids.length !== bundle.manifest.debugIdCount ||
        new Set(ids).size !== ids.length ||
        (await bundleDebugIdsDigest(ids)) !== bundle.manifest.digest
      )
        throw new ConflictError("Invalid bundle manifest");
      const expected = new Set(
        await Promise.all(ids.map((id) => debugIdPath(projectId, id))),
      );
      const owned = await ownedMarkers(projectId, bundleId);
      if (owned.some((m) => !expected.has(m.path)))
        throw new ConflictError("Unexpected bundle marker");
      await commitChunked(
        client,
        owned.map((m) => remove(m.path)),
      );
      await client.runTransaction(async (tx) => {
        const doc = await tx.get(path);
        const current = doc ? entityData<ArtifactBundle>(doc) : undefined;
        if (current?.cleanupId !== cleanupId)
          throw new ConflictError("Bundle cleanup claim changed");
        await tx.commit([
          set(path, bundleFields({ ...current, cleanupMarkersCleared: true })),
        ]);
      });
    },

    finishPendingBundleCleanup: async (projectId, bundleId, cleanupId) => {
      const path = bundlePath(projectId, bundleId);
      await client.runTransaction(async (tx) => {
        const doc = await tx.get(path);
        if (!doc) return;
        const bundle = entityData<ArtifactBundle>(doc);
        if (
          bundle.state !== "pending" ||
          !bundle.cleanupMarkersCleared ||
          bundle.cleanupId !== cleanupId
        )
          throw new ConflictError("Bundle cleanup claim changed");
        await tx.commit([remove(path)]);
      });
    },

    listBundles: (projectId, releaseId, cursor, limit) =>
      pageQuery(client, {
        query: {
          parent: projectParent(projectId),
          collection: "bundles",
          where: [eq("releaseId", releaseId)],
          orderBy: [{ field: NAME_FIELD, direction: "ASC" }],
        },
        scope: JSON.stringify(["bundles", projectId, releaseId]),
        cursor,
        limit,
        read: entityData<ArtifactBundle>,
      }),

    deleteBundle: async (projectId, bundleId) => {
      const bundle = await readBundle(projectId, bundleId);
      if (bundle?.state === "pending")
        throw new ConflictError("Pending bundles require the cleanup protocol");
      // Markers first: a crash leaves a bundle without markers (re-run completes), never
      // markers that block a debug ID forever.
      const owned = await ownedMarkers(projectId, bundleId);
      await commitChunked(
        client,
        owned.map((m) => remove(m.path)),
      );
      if (bundle)
        await client.commit([remove(bundlePath(projectId, bundleId))]);
    },

    findBundleByDebugId: async (projectId, debugId) => {
      const marker = await client.get(await debugIdPath(projectId, debugId));
      const bundleId = markerBundle(marker);
      if (bundleId === undefined) return null;
      const bundle = await readBundle(projectId, bundleId);
      return bundle?.state === "active" ? bundle : null;
    },
  };
}
