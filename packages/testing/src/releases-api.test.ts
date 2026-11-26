import {
  type ApiTokenId,
  bootstrapProject,
  chunkKey,
  hashApiToken,
  type OrgId,
  type ProjectId,
  sha1Hex,
} from "@moriyoshi/errtraq-core";
import { createApiApp } from "@moriyoshi/errtraq-http";
import { gzipSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MemoryActiveStore } from "./memory-active.js";
import { MemoryBlobStore, MemoryKV } from "./memory-other.js";
import { DeterministicIdGen, FakeClock } from "./shared.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

function bundle(
  debugIds: string[],
  options: { prefix?: boolean; types?: string[] } = {},
): Uint8Array {
  const files: Record<string, unknown> = {};
  debugIds.forEach((id, i) => {
    files[`files/_/_/f${i}.js`] = {
      type: options.types?.[i] ?? "minified_source",
      url: `~/f${i}.js`,
      headers: { "debug-id": id, Sourcemap: `f${i}.js.map` },
    };
  });
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify({ files, debug_id: ID_A })),
    "files/_/_/f0.js": strToU8("x"),
  });
  if (!options.prefix) return zip;
  // symbolic writes "SYSB" + a version before the ZIP and records offsets relative to the ZIP.
  const out = new Uint8Array(zip.length + 8);
  out.set(strToU8("SYSB"));
  out.set(zip, 8);
  return out;
}

async function setup(
  limits?: Parameters<typeof createApiApp>[0]["chunkUpload"],
  options: { ticking?: boolean } = {},
) {
  const store = new MemoryActiveStore();
  // A ticking clock moves one millisecond per reading, so racing attempts see different times.
  const clock = options.ticking
    ? new (class extends FakeClock {
        override now() {
          const value = super.now();
          this.advance(1);
          return value;
        }
      })()
    : new FakeClock();
  const ids = new DeterministicIdGen();
  const kv = new MemoryKV(clock);
  const a = await bootstrapProject({
    store,
    kv,
    ids,
    orgSlug: "org",
    projectSlug: "project",
  });
  const a2 = await store.projects.getProjectBySlug(a.org.id, "project");
  const b = await bootstrapProject({
    store,
    kv,
    ids,
    orgSlug: "other",
    projectSlug: "theirs",
  });
  for (const [id, org, secret, scopes] of [
    ["ta", a.org.id, "secret", ["event:read", "event:write"]],
    ["ro", a.org.id, "read", ["event:read"]],
    ["tb", b.org.id, "other", ["event:read", "event:write"]],
  ] as const)
    await store.projects.putToken({
      id: id as ApiTokenId,
      orgId: org,
      tokenHash: await hashApiToken(`errtraq_${secret}`),
      scopes: [...scopes],
    });
  const blobs = new MemoryBlobStore();
  const app = createApiApp({ store, clock, blobs, ids, chunkUpload: limits });
  const call = (path: string, init: RequestInit & { token?: string } = {}) =>
    app.request(`http://errtraq.test${path}`, {
      ...init,
      headers: {
        authorization: `Bearer errtraq_${init.token ?? "secret"}`,
        ...(init.body && typeof init.body === "string"
          ? { "content-type": "application/json" }
          : {}),
        ...init.headers,
      },
    });
  const post = (path: string, body: unknown, token?: string) =>
    call(path, { method: "POST", body: JSON.stringify(body), token });
  const upload = async (
    chunks: Uint8Array[],
    options: {
      gzip?: boolean;
      token?: string;
      org?: string;
      name?: string;
    } = {},
  ) => {
    const form = new FormData();
    for (const chunk of chunks)
      form.append(
        options.gzip ? "file_gzip" : "file",
        new File(
          [(options.gzip ? gzipSync(chunk) : chunk) as BlobPart],
          options.name ?? (await sha1Hex(chunk)),
        ),
      );
    return call(`/api/0/organizations/${options.org ?? "org"}/chunk-upload/`, {
      method: "POST",
      body: form,
      token: options.token,
    });
  };
  /** Split into chunks the way sentry-cli does and describe the bundle. */
  async function describeBundle(data: Uint8Array, size = 1024 * 1024) {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < data.length; i += size)
      chunks.push(data.slice(i, i + size));
    return {
      data,
      chunks,
      checksum: await sha1Hex(data),
      shas: await Promise.all(chunks.map(sha1Hex)),
    };
  }
  const assemble = (
    d: { checksum: string; shas: string[] },
    extra: Record<string, unknown> = {},
    org = "org",
    token?: string,
  ) =>
    post(
      `/api/0/organizations/${org}/artifactbundle/assemble/`,
      { checksum: d.checksum, chunks: d.shas, projects: ["project"], ...extra },
      token,
    );
  return {
    store,
    clock,
    blobs,
    a: { org: a.org.id, project: (a2?.id ?? a.project.id) as ProjectId },
    b: { org: b.org.id as OrgId, project: b.project.id as ProjectId },
    call,
    post,
    upload,
    describeBundle,
    assemble,
  };
}

describe("chunk upload and artifact bundle assembly", () => {
  it("advertises Lambda-sized limits and the artifact bundle capability", async () => {
    const { call } = await setup();
    const res = await call("/api/0/organizations/org/chunk-upload/");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      url: "http://errtraq.test/api/0/organizations/org/chunk-upload/",
      chunkSize: 1048576,
      chunksPerRequest: 3,
      hashAlgorithm: "sha1",
      compression: ["gzip"],
      accept: ["artifact_bundles"],
    });
    expect((await call("/api/0/organizations/nope/chunk-upload/")).status).toBe(
      404,
    );
  });

  it("reports missing chunks, accepts plain and gzip uploads, then assembles idempotently", async () => {
    const t = await setup({ chunkSize: 64 });
    const d = await t.describeBundle(bundle([ID_A, ID_B]), 64);
    expect(d.chunks.length).toBeGreaterThan(2);
    const first = await t.assemble(d, { version: "v1" });
    expect(await first.json()).toEqual({
      state: "not_found",
      missingChunks: [...new Set(d.shas)],
    });
    const [head, ...rest] = d.chunks;
    expect((await t.upload([head as Uint8Array])).status).toBe(200);
    const partial = await (await t.assemble(d)).json();
    expect(partial.state).toBe("not_found");
    expect(partial.missingChunks).not.toContain(d.shas[0]);
    expect((await t.upload(rest.slice(0, 3), { gzip: true })).status).toBe(200);
    for (let i = 3; i < rest.length; i += 3)
      await t.upload(rest.slice(i, i + 3), { gzip: true });
    // The same chunk twice is fine.
    expect((await t.upload([head as Uint8Array])).status).toBe(200);
    const done = await t.assemble(d, { version: "v1", dist: "1" });
    expect(await done.json()).toEqual({ state: "ok", missingChunks: [] });
    for (const id of [ID_A, ID_B]) {
      const found = await t.store.releases.findBundleByDebugId(t.a.project, id);
      expect(found?.state).toBe("active");
    }
    expect(
      await t.store.releases.findBundleByDebugId(t.b.project, ID_A),
    ).toBeNull();
    const release = await t.store.releases.getReleaseByVersion(
      t.a.project,
      "v1",
    );
    expect(release).toBeTruthy();
    // Chunks are gone, yet a repeated assemble (a retried CI step) still answers ok.
    expect(
      await t.blobs.head(chunkKey(t.a.org, d.shas[0] as string)),
    ).toBeNull();
    expect(await (await t.assemble(d, { version: "v1" })).json()).toEqual({
      state: "ok",
      missingChunks: [],
    });
  });

  it("reads a bundle with the SYSB header and resumes after a partial registration", async () => {
    const t = await setup();
    const d = await t.describeBundle(bundle([ID_A], { prefix: true }));
    await t.upload(d.chunks);
    let fail = true;
    const original = t.store.releases.verifyAndActivateBundle;
    t.store.releases.verifyAndActivateBundle = async (...args) => {
      if (fail) throw new Error("boom");
      return original(...args);
    };
    expect((await t.assemble(d)).status).toBe(500);
    fail = false;
    expect(await (await t.assemble(d)).json()).toEqual({
      state: "ok",
      missingChunks: [],
    });
    expect(
      (await t.store.releases.findBundleByDebugId(t.a.project, ID_A))?.state,
    ).toBe("active");
  });

  it("rejects bad checksums, bad gzip, stray fields and oversized requests", async () => {
    const t = await setup({ chunkSize: 16, maxRequestSize: 400 });
    const small = strToU8("hello");
    const wrong = await t.upload([small], { name: "0".repeat(40) });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).detail).toContain("Checksum mismatch");
    expect((await t.upload([small], { name: "not-a-sha" })).status).toBe(400);
    const form = new FormData();
    form.append(
      "file_gzip",
      new File([small as BlobPart], await sha1Hex(small)),
    );
    expect(
      (
        await t.call("/api/0/organizations/org/chunk-upload/", {
          method: "POST",
          body: form,
        })
      ).status,
    ).toBe(400);
    const stray = new FormData();
    stray.append("other", new File([small as BlobPart], await sha1Hex(small)));
    expect(
      (
        await t.call("/api/0/organizations/org/chunk-upload/", {
          method: "POST",
          body: stray,
        })
      ).status,
    ).toBe(400);
    const big = new Uint8Array(17).fill(1);
    expect((await t.upload([big])).status).toBe(413);
    // A gzip chunk that inflates beyond the chunk size is a zip bomb.
    expect(
      (await t.upload([new Uint8Array(4096)], { gzip: true })).status,
    ).toBe(400);
    const huge = await t.call("/api/0/organizations/org/chunk-upload/", {
      method: "POST",
      body: new Uint8Array(1000),
      headers: { "content-type": "multipart/form-data; boundary=x" },
    });
    expect(huge.status).toBe(413);
    expect(
      (
        await (
          await setup()
        ).upload(Array.from({ length: 4 }, (_, i) => strToU8(`c${i}`)))
      ).status,
    ).toBe(400);
  });

  it("enforces the maximum file size and rejects bundles it cannot use", async () => {
    const t = await setup({ chunkSize: 64, maxFileSize: 128 });
    const big = await t.describeBundle(bundle([ID_A, ID_B]), 64);
    const tooMany = await (await t.assemble(big)).json();
    expect(tooMany.state).toBe("error");
    expect(tooMany.detail).toContain("maximum file size");
    // Chunks that add up beyond the limit are refused before any are read.
    const many = new Uint8Array(200).fill(7);
    const d = await t.describeBundle(many, 100);
    await t.upload(d.chunks.slice(0, 1).map((c) => c));
    const u = await setup({ chunkSize: 100, maxFileSize: 150 });
    await u.upload(d.chunks);
    const over = await (await u.assemble(d)).json();
    expect(over.state).toBe("error");

    const v = await setup();
    for (const [name, data, detail] of [
      ["junk", strToU8("not a zip at all"), "valid ZIP"],
      [
        "empty",
        zipSync({ "manifest.json": strToU8(JSON.stringify({ files: {} })) }),
        "no debug IDs",
      ],
      ["badid", bundle(["nope"]), "Invalid debug ID"],
      ["nomanifest", zipSync({ "x.txt": strToU8("x") }), "no manifest.json"],
    ] as const) {
      const bd = await v.describeBundle(data as Uint8Array);
      await v.upload(bd.chunks);
      const r = await (await v.assemble(bd)).json();
      expect({ name, state: r.state }).toEqual({ name, state: "error" });
      expect(r.detail).toContain(detail);
    }
    // A checksum that does not match the chunks.
    const ok = await v.describeBundle(bundle([ID_A]));
    await v.upload(ok.chunks);
    const mismatch = await (
      await v.assemble({ ...ok, checksum: "a".repeat(40) })
    ).json();
    expect(mismatch.state).toBe("error");
    expect(mismatch.detail).toContain("Checksum");
    const manifestBomb = await v.describeBundle(
      zipSync({ "manifest.json": new Uint8Array(9 * 1024 * 1024) }),
    );
    await v.upload(manifestBomb.chunks);
    expect((await (await v.assemble(manifestBomb)).json()).detail).toContain(
      "too large",
    );
  });

  it("treats a re-upload of the same debug IDs as done and conflicting ones as an error", async () => {
    const t = await setup();
    const first = await t.describeBundle(bundle([ID_A, ID_B]));
    await t.upload(first.chunks);
    expect(
      (await (await t.assemble(first, { version: "v1" })).json()).state,
    ).toBe("ok");
    // Same build, different attributes (and so checksum): same debug IDs.
    const again = await t.describeBundle(
      zipSync({
        "manifest.json": strToU8(
          JSON.stringify({
            release: "v2",
            files: JSON.parse(
              new TextDecoder().decode(
                (await import("fflate")).unzipSync(first.data)[
                  "manifest.json"
                ] as Uint8Array,
              ),
            ).files,
          }),
        ),
      }),
    );
    await t.upload(again.chunks);
    expect(
      (await (await t.assemble(again, { version: "v2" })).json()).state,
    ).toBe("ok");
    // Overlap without equality is refused.
    const overlap = await t.describeBundle(bundle([ID_A]));
    await t.upload(overlap.chunks);
    const r = await (await t.assemble(overlap)).json();
    expect(r.state).toBe("error");
  });

  it("converges two interleaved first assemblies of the same bundle", async () => {
    const t = await setup(undefined, { ticking: true });
    const d = await t.describeBundle(bundle([ID_A, ID_B]));
    await t.upload(d.chunks);
    let conflicts = 0;
    const begin = t.store.releases.beginBundle;
    t.store.releases.beginBundle = async (...args) => {
      try {
        return await begin(...args);
      } catch (error) {
        conflicts++;
        throw error;
      }
    };
    // Hold both attempts at their lookup of the stored row (the 3rd and 4th reads: the first two
    // are the "already active" checks) until each has seen it absent.
    const read = t.store.releases.getBundle;
    let reads = 0;
    let arrived!: () => void;
    const both = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    t.store.releases.getBundle = async (...args) => {
      const result = await read(...args);
      if (++reads === 4 || reads === 3) {
        if (reads === 4) arrived();
        await both;
      }
      return result;
    };
    const [x, y] = await Promise.all([t.assemble(d), t.assemble(d)]);
    expect(await x?.json()).toMatchObject({ state: "ok" });
    expect(await y?.json()).toMatchObject({ state: "ok" });
    expect(conflicts).toBe(1);
    expect(
      (await t.store.releases.findBundleByDebugId(t.a.project, ID_A))?.state,
    ).toBe("active");
    // The loser's manifest was removed; only the stored row's manifest remains.
    const manifests = await t.blobs.list("artifacts/manifests/");
    expect(manifests.items).toEqual([
      (await t.store.releases.getBundle(t.a.project, d.checksum as never))
        ?.manifest.blobKey,
    ]);
  });

  it("restarts an expired pending attempt, also when cleanup already claimed it", async () => {
    for (const claimed of [false, true]) {
      const t = await setup();
      const d = await t.describeBundle(bundle([ID_A]));
      await t.upload(d.chunks);
      let fail = true;
      const original = t.store.releases.verifyAndActivateBundle;
      t.store.releases.verifyAndActivateBundle = async (...args) => {
        if (fail) throw new Error("boom");
        return original(...args);
      };
      expect((await t.assemble(d)).status).toBe(500);
      fail = false;
      const stale = await t.store.releases.getBundle(
        t.a.project,
        d.checksum as never,
      );
      expect(stale?.state).toBe("pending");
      t.clock.advance(2 * 60 * 60 * 1000);
      if (claimed)
        await t.store.releases.claimPendingBundleCleanup(
          t.a.project,
          d.checksum as never,
          t.clock.now(),
        );
      expect(await (await t.assemble(d)).json()).toEqual({
        state: "ok",
        missingChunks: [],
      });
      const fresh = await t.store.releases.getBundle(
        t.a.project,
        d.checksum as never,
      );
      expect(fresh?.state).toBe("active");
      expect(fresh?.manifest.blobKey).not.toBe(stale?.manifest.blobKey);
      expect(await t.blobs.head(stale?.manifest.blobKey as string)).toBeNull();
      expect((await t.blobs.list("artifacts/manifests/")).items).toEqual([
        fresh?.manifest.blobKey,
      ]);
    }
  });

  it("creates the requested release when an identical bundle is uploaded again", async () => {
    const t = await setup();
    const d = await t.describeBundle(bundle([ID_A]));
    await t.upload(d.chunks);
    expect((await (await t.assemble(d, { version: "v1" })).json()).state).toBe(
      "ok",
    );
    // Same checksum, new release, chunks already gone.
    expect((await (await t.assemble(d, { version: "v2" })).json()).state).toBe(
      "ok",
    );
    // Same debug IDs under a different checksum and release.
    const other = await t.describeBundle(
      zipSync({
        "manifest.json": strToU8(
          JSON.stringify({
            release: "v3",
            files: {
              "files/a.js": {
                type: "minified_source",
                headers: { "debug-id": ID_A },
              },
            },
          }),
        ),
      }),
    );
    await t.upload(other.chunks);
    expect(
      (await (await t.assemble(other, { version: "v3" })).json()).state,
    ).toBe("ok");
    for (const version of ["v1", "v2", "v3"]) {
      expect(
        await t.store.releases.getReleaseByVersion(t.a.project, version),
      ).toBeTruthy();
      const finalize = await t.call(
        `/api/0/organizations/org/releases/${version}/`,
        {
          method: "PUT",
          body: JSON.stringify({ dateReleased: "2026-01-01T00:00:00Z" }),
        },
      );
      expect(finalize.status).toBe(200);
    }
  });

  it("drops the chunks of uploads that can never assemble and keeps those of transient failures", async () => {
    const t = await setup();
    const junk = await t.describeBundle(strToU8("not a zip"));
    await t.upload(junk.chunks);
    expect((await (await t.assemble(junk)).json()).state).toBe("error");
    expect((await t.assemble(junk)).status).toBe(200);
    expect(await (await t.assemble(junk)).json()).toMatchObject({
      state: "not_found",
    });
    const bad = await t.describeBundle(bundle([ID_A]));
    await t.upload(bad.chunks);
    expect(
      (await (await t.assemble({ ...bad, checksum: "b".repeat(40) })).json())
        .state,
    ).toBe("error");
    expect(await (await t.assemble(bad)).json()).toMatchObject({
      state: "not_found",
    });
    const good = await t.describeBundle(bundle([ID_B]));
    await t.upload(good.chunks);
    const original = t.store.releases.beginBundle;
    t.store.releases.beginBundle = async () => {
      throw new Error("boom");
    };
    expect((await t.assemble(good)).status).toBe(500);
    t.store.releases.beginBundle = original;
    expect(await (await t.assemble(good)).json()).toMatchObject({
      state: "ok",
    });
  });

  it("isolates organizations and projects", async () => {
    const t = await setup();
    const d = await t.describeBundle(bundle([ID_A]));
    await t.upload(d.chunks);
    // Another organization's token cannot use this organization's routes.
    expect((await t.assemble(d, {}, "org", "other")).status).toBe(404);
    expect((await t.upload(d.chunks, { token: "other" })).status).toBe(404);
    // Another organization sees none of the uploaded chunks, even with the right checksums.
    const theirs = await t.assemble(
      d,
      { projects: ["theirs"] },
      "other",
      "other",
    );
    expect(await theirs.json()).toMatchObject({ state: "not_found" });
    // A project of another organization is not addressable.
    const cross = await t.assemble(d, { projects: ["theirs"] });
    expect(cross.status).toBe(400);
    expect((await t.assemble(d, { projects: [] })).status).toBe(400);
    expect(
      await t.store.releases.findBundleByDebugId(t.b.project, ID_A),
    ).toBeNull();
    expect((await t.assemble(d)).status).toBe(200);
    expect(
      await t.store.releases.findBundleByDebugId(t.b.project, ID_A),
    ).toBeNull();
    expect(
      await t.store.releases.findBundleByDebugId(t.a.project, ID_A),
    ).not.toBeNull();
    // Numeric project ids work, as sentry-cli sends them for numeric slugs.
    const byId = await t.assemble(d, { projects: [t.a.project] });
    expect(await byId.json()).toMatchObject({ state: "ok" });
  });

  it("requires a token with the write scope to upload", async () => {
    const t = await setup();
    expect(
      (
        await t.call("/api/0/organizations/org/chunk-upload/", {
          token: "read",
        })
      ).status,
    ).toBe(200);
    expect((await t.upload([strToU8("x")], { token: "read" })).status).toBe(
      403,
    );
    expect(
      (
        await t.post(
          "/api/0/organizations/org/artifactbundle/assemble/",
          {},
          "read",
        )
      ).status,
    ).toBe(403);
    const anonymous = await t.call("/api/0/organizations/org/chunk-upload/", {
      headers: { authorization: "" },
    });
    expect(anonymous.status).toBe(401);
  });

  it("answers 501 when no blob store is configured", async () => {
    const store = new MemoryActiveStore();
    const clock = new FakeClock();
    const boot = await bootstrapProject({
      store,
      kv: new MemoryKV(clock),
      ids: new DeterministicIdGen(),
      orgSlug: "org",
      projectSlug: "project",
    });
    await store.projects.putToken({
      id: "t" as ApiTokenId,
      orgId: boot.org.id,
      tokenHash: await hashApiToken("errtraq_secret"),
      scopes: ["event:read", "event:write"],
    });
    const app = createApiApp({ store, clock });
    const res = await app.request("/api/0/organizations/org/chunk-upload/", {
      headers: { authorization: "Bearer errtraq_secret" },
    });
    expect(res.status).toBe(501);
  });
});

describe("releases API", () => {
  it("creates, repeats, finalizes, gets and lists releases", async () => {
    const t = await setup();
    const created = await t.post("/api/0/organizations/org/releases/", {
      version: "1.0.0",
      projects: ["project"],
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body).toMatchObject({
      version: "1.0.0",
      dateReleased: null,
      projects: [{ slug: "project" }],
    });
    expect(
      (
        await t.post("/api/0/organizations/org/releases/", {
          version: "1.0.0",
          projects: ["project"],
        })
      ).status,
    ).toBe(208);
    const finalized = await t.call("/api/0/organizations/org/releases/1.0.0/", {
      method: "PUT",
      body: JSON.stringify({ dateReleased: "2026-01-02T03:04:05Z" }),
    });
    expect(finalized.status).toBe(200);
    expect((await finalized.json()).dateReleased).toBe(
      "2026-01-02T03:04:05.000Z",
    );
    const again = await t.call("/api/0/organizations/org/releases/1.0.0/", {
      method: "PUT",
      body: JSON.stringify({ dateReleased: "2027-01-01T00:00:00Z" }),
    });
    expect((await again.json()).dateReleased).toBe("2026-01-02T03:04:05.000Z");
    expect(
      (await (await t.call("/api/0/organizations/org/releases/1.0.0/")).json())
        .version,
    ).toBe("1.0.0");
    const list = await (
      await t.call("/api/0/organizations/org/releases/?query=1.0")
    ).json();
    expect(list.map((r: { version: string }) => r.version)).toEqual(["1.0.0"]);
    const projectList = await t.call("/api/0/projects/org/project/releases/");
    expect(projectList.status).toBe(200);
    expect((await projectList.json()).length).toBe(1);
    expect(
      (await t.call("/api/0/organizations/org/releases/9.9/")).status,
    ).toBe(404);
    // Releases of another organization are invisible.
    expect(
      (
        await t.call("/api/0/organizations/org/releases/1.0.0/", {
          token: "other",
        })
      ).status,
    ).toBe(404);
    const theirs = await t.call("/api/0/organizations/other/releases/1.0.0/", {
      token: "other",
    });
    expect(theirs.status).toBe(404);
  });

  it("validates input and refuses unsupported fields", async () => {
    const t = await setup();
    const post = (body: unknown) =>
      t.post("/api/0/organizations/org/releases/", body);
    expect((await post({ version: "a/b", projects: ["project"] })).status).toBe(
      400,
    );
    expect(
      (await post({ version: "latest", projects: ["project"] })).status,
    ).toBe(400);
    expect((await post({ version: "v", projects: [] })).status).toBe(400);
    expect((await post({ version: "v", projects: ["theirs"] })).status).toBe(
      400,
    );
    expect(
      (
        await post({
          version: "v",
          projects: ["project"],
          refs: [{ repository: "r", commit: "c" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post({
          version: "v",
          projects: ["project"],
          dateReleased: "nonsense",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.call("/api/0/organizations/org/releases/", {
          method: "POST",
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect((await post({ version: "v", projects: ["project"] })).status).toBe(
      201,
    );
    expect(
      (
        await t.call("/api/0/organizations/org/releases/", {
          method: "POST",
          body: "{}",
          token: "read",
        })
      ).status,
    ).toBe(403);
  });

  it("merges organization release lists completely and refuses to truncate", async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++)
      await t.store.releases.put({
        id: `r${i}` as never,
        projectId: t.a.project,
        version: `v${i}`,
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z` as never,
      });
    const list = await (
      await t.call("/api/0/organizations/org/releases/?per_page=2")
    ).json();
    expect(list.map((r: { version: string }) => r.version)).toEqual([
      "v4",
      "v3",
    ]);
    expect(
      (await t.call("/api/0/organizations/org/releases/?cursor=x")).status,
    ).toBe(400);
    for (let i = 5; i < 1010; i++)
      await t.store.releases.put({
        id: `r${i}` as never,
        projectId: t.a.project,
        version: `v${i}`,
        createdAt: "2026-02-01T00:00:00.000Z" as never,
      });
    const big = await t.call("/api/0/organizations/org/releases/");
    expect(big.status).toBe(400);
    expect((await big.json()).detail).toContain("/projects/");
    // The project route pages instead.
    const page = await t.call(
      "/api/0/projects/org/project/releases/?per_page=100",
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("link")).toContain('results="true"');
  });

  it("records and lists deploys", async () => {
    const t = await setup();
    await t.post("/api/0/organizations/org/releases/", {
      version: "1",
      projects: ["project"],
    });
    const deploy = await t.post(
      "/api/0/organizations/org/releases/1/deploys/",
      {
        environment: "production",
        name: "ship",
      },
    );
    expect(deploy.status).toBe(201);
    expect(await deploy.json()).toMatchObject({
      environment: "production",
      name: "ship",
    });
    expect(
      (
        await t.post("/api/0/organizations/org/releases/1/deploys/", {
          name: "x",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await t.post("/api/0/organizations/org/releases/2/deploys/", {
          environment: "e",
        })
      ).status,
    ).toBe(404);
    const listed = await (
      await t.call("/api/0/organizations/org/releases/1/deploys/")
    ).json();
    expect(listed).toHaveLength(1);
    expect(
      (await (await t.call("/api/0/organizations/org/releases/1/")).json())
        .deployCount,
    ).toBe(1);
  });

  it("answers legacy release-file endpoints with a clear 4xx", async () => {
    const t = await setup();
    await t.post("/api/0/organizations/org/releases/", {
      version: "1",
      projects: ["project"],
    });
    for (const [method, path] of [
      ["POST", "/api/0/organizations/org/releases/1/files/"],
      ["GET", "/api/0/projects/org/project/releases/1/files/"],
      ["POST", "/api/0/organizations/org/releases/1/assemble/"],
      ["POST", "/api/0/projects/org/project/files/difs/assemble/"],
    ] as const) {
      const res = await t.call(path, { method });
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
      expect((await res.json()).detail).toContain("sentry-cli sourcemaps");
    }
  });

  it("answers the authentication probe", async () => {
    const t = await setup();
    // sentry-cli reads only `auth` and `user`; `errtraq` is an additive extension.
    expect(await (await t.call("/api/0/")).json()).toMatchObject({
      auth: { scopes: ["event:read", "event:write"] },
      user: null,
      errtraq: { capabilities: { issueStats: true, tagFacets: true } },
    });
  });
});
