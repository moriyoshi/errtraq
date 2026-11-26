import {
  type ActiveStore,
  type ArtifactBundleService,
  type BlobStore,
  type Clock,
  type Cursor,
  deploysBlobKey,
  ensureRelease,
  gunzipBounded,
  type IdGen,
  isSha1,
  type Org,
  type Project,
  type ProjectId,
  type Release,
  readBounded,
  sha1Hex,
  toTimestamp,
  validateReleaseVersion,
} from "@moriyoshi/errtraq-core/runtime";
import type { Context, Hono } from "hono";
import type { ApiEnv } from "./api-env.js";
import { publicRequestUrl } from "./public-url.js";

type C = Context<ApiEnv>;
interface Deploy {
  id: string;
  environment: string;
  name: string | null;
  url: string | null;
  dateStarted: string | null;
  dateFinished: string;
}
const MAX_DEPLOYS = 100;
const MAX_ORG_RELEASES = 1000;
const LEGACY =
  "Legacy release files are not supported; inject debug IDs with `sentry-cli sourcemaps inject` and upload artifact bundles with `sentry-cli sourcemaps upload`";

class Bad extends Error {}

/**
 * Releases, deploys, chunk upload and artifact bundle assembly: the endpoints `sentry-cli`
 * (`releases new|finalize|list`, `deploys new`, `sourcemaps upload`) calls. Releases are stored per
 * project; the organization-level routes fan out over the projects the request names.
 */
export function addReleaseRoutes(
  app: Hono<ApiEnv>,
  options: {
    store: ActiveStore;
    clock: Clock;
    ids: IdGen;
    blobs?: BlobStore;
    bundles?: ArtifactBundleService;
    /** Configured public origin for absolute URLs (`Link`, chunk upload); absent: the request's. */
    publicOrigin?: string;
    /** Whether a second event tier is wired; advertised on the root route. */
    archiveConfigured?: boolean;
  },
): void {
  const { store, clock, ids, blobs, bundles } = options;
  const bad = (c: C, detail: string, status: 400 | 404 | 413 | 501 = 400) =>
    c.json({ detail }, status);

  async function orgOf(c: C): Promise<Org | null> {
    const org = await store.projects.getOrgBySlug(c.req.param("org") ?? "");
    return org && org.id === c.get("token").orgId ? org : null;
  }
  async function projectOf(c: C, org: Org): Promise<Project | null> {
    return store.projects.getProjectBySlug(
      org.id,
      c.req.param("project") ?? "",
    );
  }
  async function orgProjects(org: Org): Promise<Project[]> {
    const found: Project[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await store.projects.listByOrg(org.id, cursor, 100);
      found.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return found;
  }
  /** Slugs or numeric ids, as `sentry-cli` sends them; every one must belong to the organization. */
  async function resolveProjects(
    org: Org,
    entries: unknown,
  ): Promise<Project[]> {
    if (!Array.isArray(entries) || !entries.length)
      throw new Bad("At least one project is required");
    const out = new Map<string, Project>();
    for (const entry of entries) {
      if (typeof entry !== "string" && typeof entry !== "number")
        throw new Bad("Invalid project");
      const text = String(entry);
      let found = await store.projects.getProjectBySlug(org.id, text);
      if (!found && /^\d+$/.test(text)) {
        const byId = await store.projects.get(text as ProjectId);
        if (byId?.orgId === org.id) found = byId;
      }
      if (!found) throw new Bad(`Invalid project: ${text}`);
      out.set(found.id, found);
    }
    return [...out.values()];
  }
  async function body(c: C): Promise<Record<string, unknown>> {
    let value: unknown;
    try {
      value = await c.req.json();
    } catch {
      throw new Bad("Invalid JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Bad("Expected a JSON object");
    return value as Record<string, unknown>;
  }
  function date(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    const parsed = typeof value === "string" ? new Date(value) : new Date(NaN);
    if (Number.isNaN(parsed.getTime())) throw new Bad(`Invalid ${field}`);
    return toTimestamp(parsed);
  }
  function rejectUnsupported(input: Record<string, unknown>) {
    for (const field of ["commits", "refs"]) {
      const value = input[field];
      if (Array.isArray(value) ? value.length : value)
        throw new Bad(`Release ${field} are not supported`);
    }
    if (input.status !== undefined && input.status !== "open")
      throw new Bad("Archiving releases is not supported");
  }

  async function deploysOf(p: Project, r: Release): Promise<Deploy[]> {
    if (!blobs) return [];
    const stream = await blobs.get(deploysBlobKey(p.id, r.id));
    if (!stream) return [];
    return JSON.parse(
      new TextDecoder().decode(await readBounded(stream, 1024 * 1024)),
    ) as Deploy[];
  }
  async function found(org: Org, version: string, only?: Project[]) {
    const projects = only ?? (await orgProjects(org));
    const rows: Array<{ project: Project; release: Release }> = [];
    for (const project of projects) {
      const release = await store.releases.getReleaseByVersion(
        project.id,
        version,
      );
      if (release) rows.push({ project, release });
    }
    return rows;
  }
  async function releaseJson(
    rows: Array<{ project: Project; release: Release }>,
  ) {
    const first = rows[0] as { project: Project; release: Release };
    const finalized = rows
      .map((r) => r.release.finalizedAt)
      .filter((v): v is NonNullable<typeof v> => !!v)
      .sort();
    const deploys = new Map<string, Deploy>();
    for (const { project, release } of rows)
      for (const d of await deploysOf(project, release)) deploys.set(d.id, d);
    const ordered = [...deploys.values()].sort((a, b) =>
      b.dateFinished.localeCompare(a.dateFinished),
    );
    return {
      version: first.release.version,
      shortVersion: first.release.version,
      ref: null,
      url: null,
      dateCreated: rows.map((r) => r.release.createdAt).sort()[0],
      dateReleased: finalized[0] ?? null,
      data: {},
      newGroups: 0,
      owner: null,
      commitCount: 0,
      deployCount: ordered.length,
      lastCommit: null,
      lastDeploy: ordered[0] ?? null,
      authors: [],
      projects: rows.map(({ project }) => ({
        id: project.id,
        slug: project.slug,
        name: project.name,
      })),
      firstEvent: null,
      lastEvent: null,
      status: "open",
    };
  }

  async function createRelease(c: C, org: Org, fixed?: Project) {
    const input = await body(c);
    rejectUnsupported(input);
    const problem = validateReleaseVersion(input.version);
    if (problem) throw new Bad(problem);
    const version = input.version as string;
    const projects = fixed
      ? [fixed]
      : await resolveProjects(org, input.projects);
    const released = date(input.dateReleased, "dateReleased");
    let created = false;
    for (const project of projects) {
      const before = await store.releases.getReleaseByVersion(
        project.id,
        version,
      );
      const release = await ensureRelease(
        store.releases,
        ids,
        clock,
        project.id,
        version,
      );
      if (!before) created = true;
      if (released && !release.finalizedAt)
        await store.releases.put({
          ...release,
          finalizedAt: released as never,
        });
    }
    const rows = await found(org, version, projects);
    return c.json(await releaseJson(rows), created ? 201 : 208);
  }
  async function updateRelease(c: C, org: Org, fixed?: Project) {
    const version = c.req.param("version") ?? "";
    const input = await body(c);
    rejectUnsupported(input);
    const released = date(input.dateReleased, "dateReleased");
    let rows = await found(org, version, fixed ? [fixed] : undefined);
    if (!rows.length) return bad(c, "Release not found", 404);
    if (!fixed && input.projects !== undefined) {
      const extra = await resolveProjects(org, input.projects);
      for (const project of extra)
        if (!rows.some((r) => r.project.id === project.id))
          await ensureRelease(store.releases, ids, clock, project.id, version);
      rows = await found(org, version, fixed ? [fixed] : undefined);
    }
    if (released)
      for (const { release } of rows)
        if (!release.finalizedAt)
          await store.releases.put({
            ...release,
            finalizedAt: released as never,
          });
    return c.json(
      await releaseJson(
        await found(
          org,
          version,
          rows.map((r) => r.project),
        ),
      ),
    );
  }
  async function getRelease(c: C, org: Org, fixed?: Project) {
    const rows = await found(
      org,
      c.req.param("version") ?? "",
      fixed ? [fixed] : undefined,
    );
    return rows.length
      ? c.json(await releaseJson(rows))
      : bad(c, "Release not found", 404);
  }
  async function listReleases(c: C, org: Org, fixed?: Project) {
    const limitText = c.req.query("per_page") ?? c.req.query("limit");
    const limit = limitText === undefined ? 100 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Bad("Invalid page limit");
    const cursor = c.req.query("cursor") as Cursor | undefined;
    const query = c.req.query("query")?.toLowerCase();
    let projects: Project[];
    if (fixed) projects = [fixed];
    else {
      if (cursor)
        throw new Bad("Organization release lists do not take a cursor");
      const names = c.req.queries("project") ?? [];
      projects = names.length
        ? await resolveProjects(org, names)
        : await orgProjects(org);
    }
    const byVersion = new Map<
      string,
      Array<{ project: Project; release: Release }>
    >();
    let next: string | null = null;
    let examined = 0;
    for (const project of projects) {
      let projectCursor = cursor;
      do {
        const page = await store.releases.list(
          project.id,
          projectCursor,
          limit,
        );
        examined += page.items.length;
        for (const release of page.items) {
          if (query && !release.version.toLowerCase().includes(query)) continue;
          const rows = byVersion.get(release.version) ?? [];
          rows.push({ project, release });
          byVersion.set(release.version, rows);
        }
        if (fixed) {
          next = page.nextCursor;
          break;
        }
        // Organization lists merge every project's releases, so they read them all; past the
        // bound they refuse rather than return a silently truncated list.
        if (examined > MAX_ORG_RELEASES)
          throw new Bad(
            `Too many releases to merge; list one project with /projects/{org}/{project}/releases/`,
          );
        projectCursor = page.nextCursor ?? undefined;
      } while (projectCursor);
    }
    const grouped = [...byVersion.values()]
      .sort((a, b) =>
        (b[0]?.release.createdAt ?? "").localeCompare(
          a[0]?.release.createdAt ?? "",
        ),
      )
      .slice(0, limit);
    if (fixed) {
      const url = publicRequestUrl(c.req.url, options.publicOrigin);
      if (next) url.searchParams.set("cursor", next);
      else url.searchParams.delete("cursor");
      c.header(
        "Link",
        `<${url}>; rel="next"; results="${next ? "true" : "false"}"; cursor="${next ?? ""}"`,
      );
    }
    return c.json(await Promise.all(grouped.map((rows) => releaseJson(rows))));
  }
  async function createDeploy(c: C, org: Org, fixed?: Project) {
    const input = await body(c);
    const environment = input.environment;
    if (
      typeof environment !== "string" ||
      !environment ||
      environment.length > 64
    )
      throw new Bad("environment is required");
    const text = (value: unknown, field: string) => {
      if (value === undefined || value === null || value === "") return null;
      if (typeof value !== "string" || value.length > 2048)
        throw new Bad(`Invalid ${field}`);
      return value;
    };
    const started = date(input.dateStarted, "dateStarted") ?? null;
    const deploy: Deploy = {
      id: ids.next(),
      environment,
      name: text(input.name, "name"),
      url: text(input.url, "url"),
      dateStarted: started,
      dateFinished: date(input.dateFinished, "dateFinished") ?? clock.now(),
    };
    if (!blobs) return bad(c, "Deploys are not configured", 501);
    let rows = await found(
      org,
      c.req.param("version") ?? "",
      fixed ? [fixed] : undefined,
    );
    if (!fixed && input.projects !== undefined) {
      const named = await resolveProjects(org, input.projects);
      rows = rows.filter((r) => named.some((p) => p.id === r.project.id));
    }
    if (!rows.length) return bad(c, "Release not found", 404);
    // TODO(M5): deploys live in one JSON blob per release (read-modify-write, last writer
    // wins); move them to ReleaseRepo when a UI needs them or concurrent deploys matter.
    for (const { project, release } of rows) {
      const existing = await deploysOf(project, release);
      if (existing.length >= MAX_DEPLOYS)
        throw new Bad(`A release can hold at most ${MAX_DEPLOYS} deploys`);
      await blobs.put(
        deploysBlobKey(project.id, release.id),
        new TextEncoder().encode(JSON.stringify([...existing, deploy])),
        { contentType: "application/json" },
      );
    }
    return c.json(deploy, 201);
  }
  async function listDeploys(c: C, org: Org, fixed?: Project) {
    const rows = await found(
      org,
      c.req.param("version") ?? "",
      fixed ? [fixed] : undefined,
    );
    if (!rows.length) return bad(c, "Release not found", 404);
    const all = new Map<string, Deploy>();
    for (const { project, release } of rows)
      for (const d of await deploysOf(project, release)) all.set(d.id, d);
    return c.json(
      [...all.values()].sort((a, b) =>
        b.dateFinished.localeCompare(a.dateFinished),
      ),
    );
  }

  /** Route guard: resolve the organization (and project) or answer 404; map input errors to 400. */
  function route(
    scope: "org" | "project",
    handler: (c: C, org: Org, project?: Project) => Promise<Response>,
  ) {
    return async (c: C) => {
      const org = await orgOf(c);
      if (!org) return bad(c, "Not found", 404);
      try {
        if (scope === "org") return await handler(c, org);
        const project = await projectOf(c, org);
        return project
          ? await handler(c, org, project)
          : bad(c, "Not found", 404);
      } catch (error) {
        if (error instanceof Bad) return bad(c, error.message);
        throw error;
      }
    };
  }
  const org = (h: (c: C, o: Org) => Promise<Response>) =>
    route("org", (c, o) => h(c, o));
  const proj = (h: (c: C, o: Org, p?: Project) => Promise<Response>) =>
    route("project", h);

  // `auth` and `user` stay as sentry-cli reads them; `errtraq` tells the UI what the store can serve.
  const whoami = (c: C) =>
    c.json({
      auth: { scopes: c.get("token").scopes },
      user:
        c.get("token").kind === "token"
          ? null
          : {
              id: c.get("token").subject ?? null,
              ...(c.get("token").email ? { email: c.get("token").email } : {}),
            },
      errtraq: {
        principal: { kind: c.get("token").kind },
        capabilities: {
          textSearch: store.capabilities.textSearch,
          lastSeenRangeOnOtherSort: store.capabilities.lastSeenRangeOnOtherSort,
          archive: options.archiveConfigured === true,
          issueStats: !!store.stats && store.capabilities.issueStats === true,
          tagFacets: !!store.stats && store.capabilities.tagFacets === true,
        },
      },
    });
  app.get("/api/0", whoami);
  app.get("/api/0/", whoami);
  app.post("/api/0/organizations/:org/releases", org(createRelease));
  app.get("/api/0/organizations/:org/releases", org(listReleases));
  app.get("/api/0/organizations/:org/releases/:version", org(getRelease));
  app.put("/api/0/organizations/:org/releases/:version", org(updateRelease));
  app.post(
    "/api/0/organizations/:org/releases/:version/deploys",
    org(createDeploy),
  );
  app.get(
    "/api/0/organizations/:org/releases/:version/deploys",
    org(listDeploys),
  );
  app.post("/api/0/projects/:org/:project/releases", proj(createRelease));
  app.get("/api/0/projects/:org/:project/releases", proj(listReleases));
  app.get("/api/0/projects/:org/:project/releases/:version", proj(getRelease));
  app.put(
    "/api/0/projects/:org/:project/releases/:version",
    proj(updateRelease),
  );
  app.post(
    "/api/0/projects/:org/:project/releases/:version/deploys",
    proj(createDeploy),
  );
  app.get(
    "/api/0/projects/:org/:project/releases/:version/deploys",
    proj(listDeploys),
  );

  // Active artifact bundles of one release, read-only, in the shape of Sentry's project
  // `artifact-bundles` listing. `query` is required and names the release version: bundles are
  // indexed per release, and listing every bundle of a project would be a scan. `fileCount` and
  // the dates are null (the bundle record keeps neither); `errtraq.debugIdCount` is what it holds.
  app.get(
    "/api/0/projects/:org/:project/artifact-bundles",
    proj(async (c, _org, project) => {
      const version = c.req.query("query") ?? "";
      if (!version) throw new Bad("query (a release version) is required");
      const limitText = c.req.query("per_page") ?? c.req.query("limit");
      const limit = limitText === undefined ? 25 : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Bad("Invalid page limit");
      const release = await store.releases.getReleaseByVersion(
        (project as Project).id,
        version,
      );
      if (!release) return bad(c, "Release not found", 404);
      const page = await store.releases.listBundles(
        release.projectId,
        release.id,
        (c.req.query("cursor") || undefined) as Cursor | undefined,
        limit,
      );
      const url = publicRequestUrl(c.req.url, options.publicOrigin);
      if (page.nextCursor) url.searchParams.set("cursor", page.nextCursor);
      else url.searchParams.delete("cursor");
      c.header(
        "Link",
        `<${url}>; rel="next"; results="${page.nextCursor ? "true" : "false"}"; cursor="${page.nextCursor ?? ""}"`,
      );
      return c.json(
        page.items
          .filter((b) => b.state === "active" && !b.cleanupStarted)
          .map((b) => ({
            bundleId: b.id,
            associations: [{ release: release.version, dist: null }],
            fileCount: null,
            date: null,
            dateModified: null,
            errtraq: { debugIdCount: b.manifest.debugIdCount },
          })),
      );
    }),
  );

  // Commit data is not tracked; sentry-cli treats 404 as "none".
  for (const path of [
    "/api/0/organizations/:org/releases/:version/commits",
    "/api/0/organizations/:org/releases/:version/previous-with-commits",
  ])
    app.get(path, (c) => bad(c, "Release commits are not supported", 404));
  // Legacy release-file upload, release bundle assembly and DIF endpoints.
  for (const path of [
    "/api/0/organizations/:org/releases/:version/files",
    "/api/0/organizations/:org/releases/:version/files/*",
    "/api/0/organizations/:org/releases/:version/assemble",
    "/api/0/projects/:org/:project/releases/:version/files",
    "/api/0/projects/:org/:project/releases/:version/files/*",
    "/api/0/projects/:org/:project/files/source-maps",
    "/api/0/projects/:org/:project/files/difs/assemble",
    "/api/0/projects/:org/:project/files/dsyms",
  ])
    app.all(path, (c) => bad(c, LEGACY));

  // --- chunk upload and artifact bundle assembly ---
  const unavailable = (c: C) =>
    bad(c, "Artifact uploads are not configured", 501);
  app.get(
    "/api/0/organizations/:org/chunk-upload",
    org(async (c, o) => {
      if (!bundles) return unavailable(c);
      const l = bundles.limits;
      return c.json({
        url: `${publicRequestUrl(c.req.url, options.publicOrigin).origin}/api/0/organizations/${encodeURIComponent(o.slug)}/chunk-upload/`,
        chunkSize: l.chunkSize,
        chunksPerRequest: l.chunksPerRequest,
        maxRequestSize: l.maxRequestSize,
        maxFileSize: l.maxFileSize,
        maxWait: 60,
        concurrency: l.concurrency,
        hashAlgorithm: "sha1",
        compression: ["gzip"],
        accept: ["artifact_bundles"],
      });
    }),
  );
  app.post(
    "/api/0/organizations/:org/chunk-upload",
    org(async (c, o) => {
      if (!bundles) return unavailable(c);
      const l = bundles.limits;
      const declared = Number(c.req.header("content-length") ?? 0);
      if (declared > l.maxRequestSize) return bad(c, "Request too large", 413);
      const stream = c.req.raw.body;
      if (!stream) return bad(c, "Expected a multipart body");
      let bytes: Uint8Array;
      try {
        bytes = await readBounded(stream, l.maxRequestSize);
      } catch (error) {
        if (error instanceof RangeError)
          return bad(c, "Request too large", 413);
        throw error;
      }
      let form: FormData;
      try {
        form = await new Response(bytes as BodyInit, {
          headers: { "content-type": c.req.header("content-type") ?? "" },
        }).formData();
      } catch {
        return bad(c, "Invalid multipart body");
      }
      const parts: Array<[string, File]> = [];
      let unexpected = false;
      form.forEach((value, name) => {
        if (
          (name !== "file" && name !== "file_gzip") ||
          typeof value === "string"
        )
          unexpected = true;
        else parts.push([name, value]);
      });
      if (unexpected) return bad(c, "Unexpected multipart field");
      if (!parts.length || parts.length > l.chunksPerRequest)
        return bad(c, `Expected 1 to ${l.chunksPerRequest} chunks`);
      const verified: Array<[string, Uint8Array]> = [];
      for (const [name, file] of parts) {
        if (!isSha1(file.name)) return bad(c, "Chunk name must be its SHA-1");
        let data: Uint8Array = new Uint8Array(await file.arrayBuffer());
        if (name === "file_gzip") {
          try {
            data = await gunzipBounded(data, l.chunkSize);
          } catch {
            return bad(c, "Invalid or oversized gzip chunk");
          }
        }
        if (data.length > l.chunkSize) return bad(c, "Chunk too large", 413);
        if ((await sha1Hex(data)) !== file.name)
          return bad(c, `Checksum mismatch for chunk ${file.name}`);
        verified.push([file.name, data]);
      }
      for (const [sha1, data] of verified)
        await bundles.putChunk(o.id, sha1, data);
      return c.json({});
    }),
  );
  app.post(
    "/api/0/organizations/:org/artifactbundle/assemble",
    org(async (c, o) => {
      if (!bundles) return unavailable(c);
      const input = await body(c);
      if (!isSha1(input.checksum)) throw new Bad("Invalid checksum");
      if (!Array.isArray(input.chunks) || !input.chunks.every(isSha1))
        throw new Bad("Invalid chunks");
      const optional = (value: unknown, field: string) => {
        if (value === undefined || value === null || value === "")
          return undefined;
        if (typeof value !== "string" || value.length > 200)
          throw new Bad(`Invalid ${field}`);
        return value;
      };
      const version = optional(input.version, "version");
      if (version) {
        const problem = validateReleaseVersion(version);
        if (problem) throw new Bad(problem);
      }
      const projects = await resolveProjects(o, input.projects);
      const result = await bundles.assemble({
        orgId: o.id,
        projectIds: projects.map((p) => p.id),
        checksum: input.checksum,
        chunks: input.chunks as string[],
        version,
        dist: optional(input.dist, "dist"),
      });
      return c.json(result);
    }),
  );
}
