import type { ArtifactBundleId, ProjectId, Timestamp } from "./domain.js";
import { ConflictError } from "./errors.js";
import { bundleDebugIdsDigest } from "./ids.js";
import type { BlobStore, ReleaseRepo } from "./ports.js";

/** Resume cleanup safely after failure at any step; manifest is a JSON array of debug IDs. */
export async function cleanupPendingBundle(
  releases: ReleaseRepo,
  blobs: BlobStore,
  projectId: ProjectId,
  bundleId: ArtifactBundleId,
  before: Timestamp,
): Promise<boolean> {
  let bundle = await releases.claimPendingBundleCleanup(
    projectId,
    bundleId,
    before,
  );
  if (!bundle) return false;
  const cleanupId = bundle.cleanupId;
  if (!cleanupId) throw new ConflictError("Bundle cleanup claim missing token");
  if (!bundle.cleanupMarkersCleared) {
    const body = await blobs.get(bundle.manifest.blobKey);
    if (!body) {
      bundle = await releases.claimPendingBundleCleanup(
        projectId,
        bundleId,
        before,
      );
      if (!bundle) return false;
      if (bundle.cleanupId !== cleanupId)
        throw new ConflictError("Bundle cleanup claim changed");
      if (!bundle.cleanupMarkersCleared)
        throw new ConflictError("Pending bundle manifest missing");
    } else {
      const value: unknown = await new Response(body).json();
      if (
        !Array.isArray(value) ||
        !value.every((id) => typeof id === "string") ||
        new Set(value).size !== value.length ||
        value.length !== bundle.manifest.debugIdCount ||
        (await bundleDebugIdsDigest(value)) !== bundle.manifest.digest
      )
        throw new ConflictError("Invalid bundle manifest");
      await releases.clearPendingBundleDebugIds(
        projectId,
        bundleId,
        value,
        cleanupId,
      );
    }
  }
  // The pending bundle blob is orphaned by cleanup; a later upload rewrites it.
  await blobs.delete(bundle.blobKey);
  await blobs.delete(bundle.manifest.blobKey);
  await releases.finishPendingBundleCleanup(projectId, bundleId, cleanupId);
  return true;
}
