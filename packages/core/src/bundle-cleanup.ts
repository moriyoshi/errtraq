import {
  type ArtifactBundleId,
  type Cursor,
  type ProjectId,
  type Timestamp,
  toTimestamp,
} from "./domain.js";
import { ConflictError } from "./errors.js";
import { bundleDebugIdsDigest } from "./ids.js";
import { redactLogText } from "./log-redaction.js";
import type { BlobStore, Logger, ProjectRepo, ReleaseRepo } from "./ports.js";

/** Resume cleanup safely after failure at any step; manifest is a JSON array of debug IDs. */
export async function cleanupPendingBundle(
  releases: Pick<
    ReleaseRepo,
    | "claimPendingBundleCleanup"
    | "clearPendingBundleDebugIds"
    | "finishPendingBundleCleanup"
  >,
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

/** Bounds for one `bundle-cleanup` cron run. */
export interface BundleCleanupLimits {
  /** Pending bundles cleaned per run; the rest wait for a later tick. */
  maxBundles: number;
  /** Projects examined per run (a window that rotates between runs). */
  maxProjects: number;
  /** Pending bundles cleaned per project per run, so one busy project cannot take the budget. */
  maxBundlesPerProject: number;
  pageSize: number;
}
export const DEFAULT_BUNDLE_CLEANUP_LIMITS: BundleCleanupLimits = {
  maxBundles: 25,
  maxProjects: 1000,
  maxBundlesPerProject: 10,
  pageSize: 50,
};
/** FNV-1a; scrambles the run time into the start of the project window. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
/** Blob stores without lifecycle rules (blob-fs) may expire abandoned objects themselves. */
export interface ExpiringBlobStore {
  expireOlderThan(prefix: string, olderThan: Timestamp): Promise<number>;
}
export const isExpiringBlobStore = (
  blobs: object,
): blobs is ExpiringBlobStore =>
  typeof (blobs as Partial<ExpiringBlobStore>).expireOlderThan === "function";
/** Chunks never assembled (client crash) live this long; S3 uses the same lifecycle window. */
export const ABANDONED_CHUNK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Clean expired pending bundles across projects, at most `maxBundles` per run, and expire
 * abandoned upload chunks on blob stores that cannot do it themselves. Failures of one bundle
 * are logged and do not stop the run; the claim protocol makes every step resumable.
 *
 * Fairness without persisted state (the cron role holds no KV or blob write): when there are more
 * projects than `maxProjects`, each run examines a circular window of the project order whose
 * start is a hash of the run time, and one project cleans at most `maxBundlesPerProject` bundles.
 * A starved project is therefore reached by a later run with probability 1, whatever the early
 * projects hold. Returns the number of bundles cleaned.
 */
export async function runBundleCleanup(
  deps: {
    projects: Pick<ProjectRepo, "list">;
    releases: Pick<
      ReleaseRepo,
      | "listPendingBundles"
      | "claimPendingBundleCleanup"
      | "clearPendingBundleDebugIds"
      | "finishPendingBundleCleanup"
    >;
    blobs: BlobStore;
    logger: Pick<Logger, "info" | "warn" | "error">;
  },
  now: Timestamp,
  limits: BundleCleanupLimits = DEFAULT_BUNDLE_CLEANUP_LIMITS,
): Promise<number> {
  let cleaned = 0;
  let failed = 0;
  let stopped = false;
  const cleanProject = async (projectId: ProjectId) => {
    let done = 0;
    let bundleCursor: Cursor | undefined;
    const budget = () =>
      Math.min(limits.maxBundles - cleaned, limits.maxBundlesPerProject - done);
    do {
      const bundles = await deps.releases.listPendingBundles(
        projectId,
        now,
        bundleCursor,
        Math.max(1, Math.min(limits.pageSize, budget())),
      );
      bundleCursor = bundles.nextCursor ?? undefined;
      for (const bundle of bundles.items) {
        try {
          if (
            await cleanupPendingBundle(
              deps.releases,
              deps.blobs,
              projectId,
              bundle.id,
              now,
            )
          ) {
            cleaned++;
            done++;
          }
        } catch (error) {
          failed++;
          deps.logger.error("Pending bundle cleanup failed", {
            projectId,
            bundleId: bundle.id,
            error: redactLogText(String(error)),
          });
        }
        if (cleaned >= limits.maxBundles) {
          deps.logger.warn("Bundle cleanup reached its bundle limit", {
            bundles: limits.maxBundles,
          });
          stopped = true;
          return;
        }
        if (done >= limits.maxBundlesPerProject) return;
      }
    } while (bundleCursor && budget() > 0);
  };
  /** Visit `count` projects starting at position `from` of the project order. */
  const visit = async (from: number, count: number) => {
    let index = 0;
    let visited = 0;
    let cursor: Cursor | undefined;
    do {
      const page = await deps.projects.list(cursor, limits.pageSize);
      cursor = page.nextCursor ?? undefined;
      for (const project of page.items) {
        if (index++ < from) continue;
        if (visited >= count || stopped) return visited;
        visited++;
        await cleanProject(project.id);
        if (stopped) return visited;
      }
    } while (cursor);
    return visited;
  };
  // One listing pass: keep the first `maxProjects` IDs (the common case needs nothing more) and
  // only count the rest.
  let total = 0;
  const first: ProjectId[] = [];
  {
    let cursor: Cursor | undefined;
    do {
      const page = await deps.projects.list(cursor, limits.pageSize);
      cursor = page.nextCursor ?? undefined;
      for (const project of page.items) {
        total++;
        if (first.length < limits.maxProjects) first.push(project.id);
      }
    } while (cursor);
  }
  const window = Math.min(limits.maxProjects, total);
  if (total <= limits.maxProjects) {
    for (const id of first) {
      await cleanProject(id);
      if (stopped) break;
    }
  } else {
    const start = fnv1a(now) % total;
    const tail = await visit(start, Math.min(window, total - start));
    if (!stopped && tail < window) await visit(0, window - tail);
  }
  if (!stopped && total > window)
    deps.logger.warn("Bundle cleanup reached its project limit", {
      projects: limits.maxProjects,
    });
  if (isExpiringBlobStore(deps.blobs)) {
    const cutoff = toTimestamp(
      new Date(Date.parse(now) - ABANDONED_CHUNK_TTL_MS),
    );
    try {
      const removed = await deps.blobs.expireOlderThan(
        "artifacts/chunks/",
        cutoff,
      );
      if (removed)
        deps.logger.info("Expired abandoned artifact chunks", { removed });
    } catch (error) {
      deps.logger.error("Chunk expiry failed", {
        error: redactLogText(String(error)),
      });
    }
  }
  if (cleaned || failed)
    deps.logger.info("Bundle cleanup finished", { cleaned, failed });
  return cleaned;
}
