import {
  type ApiTokenId,
  type ArtifactBundleId,
  bootstrapProject,
  bundleDebugIdsDigest,
  hashApiToken,
  type ReleaseId,
} from "@moriyoshi/errtraq-core";
import { createApiApp } from "@moriyoshi/errtraq-http";
import { describe, expect, it } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryBlobStore, MemoryKV } from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

const DEBUG_ID = "11111111-1111-4111-8111-111111111111";
const CHECKSUM = "a".repeat(40) as ArtifactBundleId;

async function setup() {
  const store = new MemoryActiveStore();
  const clock = new FakeClock();
  const ids = new DeterministicIdGen();
  const boot = await bootstrapProject({
    store,
    kv: new MemoryKV(clock),
    ids,
    orgSlug: "org",
    projectSlug: "project",
  });
  await store.projects.putToken({
    id: "t" as ApiTokenId,
    orgId: boot.org.id,
    tokenHash: await hashApiToken("errtraq_secret"),
    scopes: ["event:read"],
  });
  const app = createApiApp({ store, clock, blobs: new MemoryBlobStore(), ids });
  const get = (path: string) =>
    Promise.resolve(
      app.request(`http://errtraq.test${path}`, {
        headers: { authorization: "Bearer errtraq_secret" },
      }),
    );
  const release = {
    id: "release-1" as ReleaseId,
    projectId: boot.project.id,
    version: "v1",
    createdAt: clock.now(),
  };
  await store.releases.put(release);
  return { store, boot, get, release };
}

describe("GET /projects/{org}/{project}/artifact-bundles/", () => {
  it("lists the active bundles of one release in Sentry's shape", async () => {
    const c = await setup();
    const manifest = {
      blobKey: "bundles/x",
      digest: await bundleDebugIdsDigest([DEBUG_ID]),
      debugIdCount: 1,
    };
    await c.store.releases.beginBundle(
      {
        id: CHECKSUM,
        projectId: c.boot.project.id,
        releaseId: c.release.id,
        blobKey: "bundles/x",
        state: "pending",
        manifest,
        pendingExpiresAt: c.release.createdAt,
      },
      manifest,
    );
    // Pending bundles are not listed.
    const before = await c.get(
      "/api/0/projects/org/project/artifact-bundles/?query=v1",
    );
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual([]);
    await c.store.releases.putBundleDebugIds(
      c.boot.project.id,
      CHECKSUM,
      [DEBUG_ID],
      [DEBUG_ID],
    );
    await c.store.releases.verifyAndActivateBundle(
      c.boot.project.id,
      CHECKSUM,
      [DEBUG_ID],
    );
    const res = await c.get(
      "/api/0/projects/org/project/artifact-bundles/?query=v1",
    );
    expect(res.headers.get("link")).toContain('rel="next"; results="false"');
    expect(await res.json()).toEqual([
      {
        bundleId: CHECKSUM,
        associations: [{ release: "v1", dist: null }],
        fileCount: null,
        date: null,
        dateModified: null,
        errtraq: { debugIdCount: 1 },
      },
    ]);
  });

  it("requires a release query and answers 404 for an unknown release or project", async () => {
    const c = await setup();
    const base = "/api/0/projects/org/project/artifact-bundles/";
    expect((await c.get(base)).status).toBe(400);
    expect((await c.get(`${base}?query=nope`)).status).toBe(404);
    expect((await c.get(`${base}?query=v1&per_page=0`)).status).toBe(400);
    expect(
      (await c.get("/api/0/projects/org/other/artifact-bundles/?query=v1"))
        .status,
    ).toBe(404);
    expect(
      (await c.get("/api/0/projects/nope/project/artifact-bundles/?query=v1"))
        .status,
    ).toBe(404);
  });
});
