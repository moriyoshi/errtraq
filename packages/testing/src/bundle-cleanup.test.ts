import {
  type ArtifactBundle,
  type ArtifactBundleId,
  bootstrapProject,
  bundleDebugIdsDigest,
  createCronHandler,
  type ProjectId,
  type ReleaseId,
  runBundleCleanup,
  toTimestamp,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it, vi } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryBlobStore, MemoryKV } from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function setup() {
  const store = new MemoryActiveStore();
  const clock = new FakeClock();
  const blobs = new MemoryBlobStore();
  const kv = new MemoryKV(clock);
  const ids = new DeterministicIdGen();
  const projects: ProjectId[] = [];
  for (const slug of ["one", "two", "three"]) {
    const boot = await bootstrapProject({
      store,
      kv,
      ids,
      orgSlug: `org-${slug}`,
      projectSlug: slug,
    });
    projects.push(boot.project.id);
  }
  const expiry = (ms: number) =>
    toTimestamp(new Date(Date.parse(clock.now()) + ms));
  async function pending(
    projectId: ProjectId,
    name: string,
    debugId: string,
    expiresIn: number,
    manifestBody?: string,
  ) {
    const debugIds = [debugId];
    const manifest = {
      blobKey: `artifacts/manifests/${projectId}/${name}`,
      digest: await bundleDebugIdsDigest(debugIds),
      debugIdCount: 1,
    };
    const bundle: ArtifactBundle = {
      id: name as ArtifactBundleId,
      projectId,
      releaseId: "unreleased" as ReleaseId,
      blobKey: `artifacts/bundles/${projectId}/${name}`,
      state: "pending",
      manifest,
      pendingExpiresAt: expiry(expiresIn),
    };
    await blobs.put(
      manifest.blobKey,
      new TextEncoder().encode(manifestBody ?? JSON.stringify(debugIds)),
    );
    await blobs.put(bundle.blobKey, new Uint8Array([1]));
    await store.releases.beginBundle(bundle, manifest);
    await store.releases.putBundleDebugIds(
      projectId,
      bundle.id,
      debugIds,
      debugIds,
    );
    return bundle;
  }
  const deps = (log = logger(), b = blobs) => ({
    projects: store.projects,
    releases: store.releases,
    blobs: b,
    logger: log,
  });
  return { store, clock, blobs, projects, pending, deps };
}
const pad = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

describe("pending bundle cleanup cron", () => {
  it("cleans expired pending bundles across projects and leaves live ones", async () => {
    const t = await setup();
    const [one, two, three] = t.projects as [ProjectId, ProjectId, ProjectId];
    const a = await t.pending(one, "a", pad(1), 1000);
    await t.pending(two, "b", pad(2), 1000);
    const live = await t.pending(three, "c", pad(3), 10 * 60 * 1000);
    t.clock.advance(2000);
    expect(await runBundleCleanup(t.deps(), t.clock.now())).toBe(2);
    expect(await t.blobs.head(a.blobKey)).toBeNull();
    expect(await t.blobs.head(a.manifest.blobKey)).toBeNull();
    expect(await t.store.releases.getBundle(one, a.id)).toBeNull();
    expect(await t.store.releases.getBundle(three, live.id)).not.toBeNull();
    expect(await t.blobs.head(live.blobKey)).not.toBeNull();
    // The ownership marker is gone: another bundle may now claim the debug ID.
    const again = await t.pending(one, "a2", pad(1), 1000);
    expect(await t.store.releases.getBundle(one, again.id)).not.toBeNull();
  });

  it("stops at the per-run bundle limit and finishes on the next run", async () => {
    const t = await setup();
    const [one, two, three] = t.projects as [ProjectId, ProjectId, ProjectId];
    await t.pending(one, "a", pad(1), 1000);
    await t.pending(two, "b", pad(2), 1000);
    await t.pending(three, "c", pad(3), 1000);
    t.clock.advance(2000);
    const limits = {
      maxBundles: 2,
      maxProjects: 100,
      maxBundlesPerProject: 10,
      pageSize: 1,
    };
    const log = logger();
    expect(await runBundleCleanup(t.deps(log), t.clock.now(), limits)).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(
      "Bundle cleanup reached its bundle limit",
      { bundles: 2 },
    );
    expect(await runBundleCleanup(t.deps(), t.clock.now(), limits)).toBe(1);
    expect(await runBundleCleanup(t.deps(), t.clock.now(), limits)).toBe(0);
  });

  it("examines a rotating window when there are more projects than the project limit", async () => {
    const t = await setup();
    const [one, two, three] = t.projects as [ProjectId, ProjectId, ProjectId];
    await t.pending(one, "a", pad(1), 1000);
    await t.pending(two, "b", pad(2), 1000);
    await t.pending(three, "c", pad(3), 1000);
    t.clock.advance(2000);
    const log = logger();
    const limits = {
      maxBundles: 10,
      maxProjects: 1,
      maxBundlesPerProject: 10,
      pageSize: 1,
    };
    expect(await runBundleCleanup(t.deps(log), t.clock.now(), limits)).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      "Bundle cleanup reached its project limit",
      { projects: 1 },
    );
    // Later ticks start elsewhere, so every project is reached.
    let total = 1;
    for (let tick = 0; tick < 60 && total < 3; tick++) {
      t.clock.advance(15 * 60 * 1000);
      total += await runBundleCleanup(t.deps(), t.clock.now(), limits);
    }
    expect(total).toBe(3);
  });

  it("does not starve later projects behind projects that always have a full budget of work", async () => {
    const t = await setup();
    const [one, two, three] = t.projects as [ProjectId, ProjectId, ProjectId];
    const limits = {
      maxBundles: 2,
      maxProjects: 2,
      maxBundlesPerProject: 1,
      pageSize: 1,
    };
    await t.pending(three, "target", pad(900), 1000);
    let n = 0;
    let target: unknown = "pending";
    for (let tick = 0; tick < 80 && target; tick++) {
      // The early projects are refilled before every tick, each holding 2 expired bundles.
      for (const early of [one, two])
        for (let k = 0; k < 2; k++) {
          n++;
          await t.pending(early, `fill${n}`, pad(n), 1000);
        }
      t.clock.advance(15 * 60 * 1000);
      await runBundleCleanup(t.deps(), t.clock.now(), limits);
      target = await t.store.releases.getBundle(
        three,
        "target" as ArtifactBundleId,
      );
    }
    expect(target).toBeNull();
  });

  it("logs one failing bundle and continues with the others", async () => {
    const t = await setup();
    const [one, two] = t.projects as [ProjectId, ProjectId, ProjectId];
    await t.pending(one, "bad", pad(1), 1000, "{not json");
    await t.pending(two, "good", pad(2), 1000);
    t.clock.advance(2000);
    const log = logger();
    expect(await runBundleCleanup(t.deps(log), t.clock.now())).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      "Pending bundle cleanup failed",
      expect.objectContaining({ projectId: one, bundleId: "bad" }),
    );
  });

  it("expires abandoned chunks on blob stores that cannot do it themselves", async () => {
    const t = await setup();
    const expireOlderThan = vi.fn(async () => 3);
    const blobs = Object.assign(Object.create(t.blobs), { expireOlderThan });
    const now = t.clock.now();
    await runBundleCleanup(t.deps(logger(), blobs), now);
    expect(expireOlderThan).toHaveBeenCalledWith(
      "artifacts/chunks/",
      toTimestamp(new Date(Date.parse(now) - 7 * 24 * 60 * 60 * 1000)),
    );
  });

  it("is routed by the cron handler and needs its adapters", async () => {
    const t = await setup();
    const [one] = t.projects as [ProjectId];
    await t.pending(one, "a", pad(1), 1000);
    t.clock.advance(2000);
    const log = logger();
    await expect(
      createCronHandler(log)("bundle-cleanup", t.clock.now()),
    ).rejects.toThrow("Bundle cleanup adapters are missing");
    await createCronHandler(log, undefined, {
      projects: t.store.projects,
      releases: t.store.releases,
      blobs: t.blobs,
    })("bundle-cleanup", t.clock.now());
    expect(
      await t.store.releases.getBundle(one, "a" as ArtifactBundleId),
    ).toBeNull();
  });
});
