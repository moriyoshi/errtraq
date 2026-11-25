import { unzipSync } from "fflate";
import { cleanupPendingBundle } from "./bundle-cleanup.js";
import {
  type ArtifactBundle,
  type ArtifactBundleId,
  type OrgId,
  type ProjectId,
  type Release,
  type ReleaseId,
  toTimestamp,
} from "./domain.js";
import { ConflictError } from "./errors.js";
import { bundleDebugIdsDigest } from "./ids.js";
import type { BlobStore, Clock, IdGen, ReleaseRepo } from "./ports.js";

/**
 * Sentry-compatible artifact bundle upload: content-addressed chunk storage and assembly.
 *
 * Blob layout (all under `artifacts/`, the prefix every runtime role already holds):
 * - `artifacts/chunks/<orgId>/<sha1>`: uploaded chunks, scoped to the organization so one
 *   tenant cannot probe or assemble another's chunks. Expired by lifecycle policy.
 * - `artifacts/bundles/<projectId>/<checksum>`: the uploaded bundle exactly as received.
 * - `artifacts/manifests/<projectId>/<checksum>/<pendingExpiresAt>`: the immutable debug-ID
 *   manifest. The bundle id is the checksum, and each attempt's key embeds its own pending expiry
 *   (a millisecond timestamp that moves on after every cleanup), so a key is never reused for a
 *   new bundle row; racing attempts that choose different keys converge on the stored row.
 * - `artifacts/deploys/<projectId>/<releaseId>.json`: release deploys (see release routes).
 */
export interface ChunkUploadLimits {
  /** Largest chunk, compressed or not, after decompression. */
  chunkSize: number;
  /** Chunks accepted in one POST. */
  chunksPerRequest: number;
  /** Largest POST body in bytes. */
  maxRequestSize: number;
  /** Largest assembled bundle in bytes; bounds the memory one assembly may use. */
  maxFileSize: number;
  /** Parallel POSTs a client may run. */
  concurrency: number;
  /** Largest `manifest.json` inside a bundle once inflated. */
  maxManifestBytes: number;
  /** Most distinct debug IDs one bundle may register. */
  maxDebugIds: number;
}

/**
 * Defaults sized for AWS Lambda function URLs, whose request body limit is 6 MB (base64 encoded,
 * so about 4.5 MB of raw multipart): three 1 MiB chunks per request. A 32 MiB bundle is held in
 * memory once during assembly, which fits a 256 MB function.
 */
export const DEFAULT_CHUNK_UPLOAD_LIMITS: ChunkUploadLimits = {
  chunkSize: 1024 * 1024,
  chunksPerRequest: 3,
  maxRequestSize: 3 * 1024 * 1024 + 64 * 1024,
  maxFileSize: 32 * 1024 * 1024,
  concurrency: 4,
  maxManifestBytes: 8 * 1024 * 1024,
  maxDebugIds: 10_000,
};

/** The release id used by bundles uploaded without a release version. */
export const UNRELEASED = "unreleased" as ReleaseId;
/** How long a pending bundle may wait for activation before cleanup may claim it. */
export const PENDING_BUNDLE_TTL_MS = 60 * 60 * 1000;
const DEBUG_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA1 = /^[0-9a-f]{40}$/;

export const isSha1 = (value: unknown): value is string =>
  typeof value === "string" && SHA1.test(value);
export const chunkKey = (orgId: OrgId, sha1: string) =>
  `artifacts/chunks/${orgId}/${sha1}`;
export const bundleBlobKey = (projectId: ProjectId, checksum: string) =>
  `artifacts/bundles/${projectId}/${checksum}`;
export const manifestBlobKey = (
  projectId: ProjectId,
  checksum: string,
  pendingExpiresAt: string,
) =>
  `artifacts/manifests/${projectId}/${checksum}/${encodeURIComponent(pendingExpiresAt)}`;
export const deploysBlobKey = (projectId: ProjectId, releaseId: ReleaseId) =>
  `artifacts/deploys/${projectId}/${releaseId}.json`;

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function sha1Hex(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", data as BufferSource));
}

/** Read a stream into one array, failing as soon as it exceeds `max` bytes. */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new RangeError("Body exceeds the size limit");
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Inflate gzip data, refusing to produce more than `max` bytes. */
export async function gunzipBounded(
  data: Uint8Array,
  max: number,
): Promise<Uint8Array> {
  const source = new Blob([data as BlobPart]).stream();
  return readBounded(
    source.pipeThrough(
      new DecompressionStream("gzip"),
    ) as ReadableStream<Uint8Array>,
    max,
  );
}

/** Raised for caller mistakes in the uploaded data; reported to the client as an `error` state. */
export class BundleRejectedError extends Error {
  override name = "BundleRejectedError";
}

export interface ParsedBundle {
  /** Distinct, lowercase debug IDs of the minified source and source map entries, sorted. */
  debugIds: string[];
  /** Number of file entries in the bundle manifest. */
  fileCount: number;
}

function entries(value: unknown): Array<[string, unknown]> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

/**
 * Inflate the members of a bundle ZIP that `filter` selects (it must select `manifest.json`). A source bundle may start with the
 * 8-byte `SYSB` header that `symbolic` writes before the ZIP; the ZIP is first read as is (the
 * writer records absolute offsets) and then without it. `zipped` is false when neither parses.
 * The first candidate that contains a `manifest.json` wins.
 */
export function openBundleZip(
  data: Uint8Array,
  filter: (file: { name: string; originalSize: number }) => boolean,
): { zipped: boolean; files: Record<string, Uint8Array> } {
  let zipped = false;
  let files: Record<string, Uint8Array> = {};
  for (const candidate of [data, data.subarray(8)]) {
    try {
      const found = unzipSync(candidate, { filter });
      zipped = true;
      files = found;
      if (found["manifest.json"]) break;
    } catch (error) {
      if (error instanceof BundleRejectedError) throw error;
    }
  }
  return { zipped, files };
}

/**
 * Read the debug IDs from an artifact bundle. Only `manifest.json` is inflated (and size
 * checked before inflating), so a hostile archive cannot make assembly expand its other
 * members. A source bundle may start with the 8-byte `SYSB` header that `symbolic` writes before
 * the ZIP; the ZIP is first read as is (the writer records absolute offsets) and then without it.
 */
export function parseArtifactBundle(
  data: Uint8Array,
  limits: Pick<ChunkUploadLimits, "maxManifestBytes" | "maxDebugIds">,
): ParsedBundle {
  const filter = (file: { name: string; originalSize: number }) => {
    if (file.name !== "manifest.json") return false;
    if (file.originalSize > limits.maxManifestBytes)
      throw new BundleRejectedError("Bundle manifest is too large");
    return true;
  };
  const opened = openBundleZip(data, filter);
  const zipped = opened.zipped;
  const raw = opened.files["manifest.json"];
  if (!zipped)
    throw new BundleRejectedError("Bundle is not a valid ZIP archive");
  if (!raw) throw new BundleRejectedError("Bundle has no manifest.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
  } catch {
    throw new BundleRejectedError("Bundle manifest is not valid JSON");
  }
  const fileEntries = entries((manifest as { files?: unknown } | null)?.files);
  const ids = new Set<string>();
  for (const [path, info] of fileEntries) {
    const record = info as { type?: unknown; headers?: unknown } | null;
    if (record?.type !== "minified_source" && record?.type !== "source_map")
      continue;
    for (const [name, value] of entries(record.headers)) {
      if (name.toLowerCase() !== "debug-id") continue;
      const id = typeof value === "string" ? value.toLowerCase() : "";
      if (!DEBUG_ID.test(id))
        throw new BundleRejectedError(`Invalid debug ID for ${path}`);
      ids.add(id);
    }
  }
  if (!ids.size)
    throw new BundleRejectedError(
      "Bundle has no debug IDs; run `sentry-cli sourcemaps inject` before uploading",
    );
  if (ids.size > limits.maxDebugIds)
    throw new BundleRejectedError("Bundle has too many debug IDs");
  return { debugIds: [...ids].sort(), fileCount: fileEntries.length };
}

/** A release version Sentry would accept: no slashes or whitespace controls, not `.`/`..`/`latest`. */
export function validateReleaseVersion(version: unknown): string | null {
  if (typeof version !== "string" || !version.trim())
    return "Version is required";
  if (new TextEncoder().encode(version).length > 200)
    return "Version is too long";
  if (/[\\/\n\r\t\f]/.test(version) || /^\s|\s$/.test(version))
    return "Version cannot contain slashes or surrounding whitespace";
  if (version === "." || version === ".." || version.toLowerCase() === "latest")
    return "Version is reserved";
  return null;
}

/** Return the release for `version`, creating it when absent (a concurrent create converges). */
export async function ensureRelease(
  releases: ReleaseRepo,
  ids: IdGen,
  clock: Clock,
  projectId: ProjectId,
  version: string,
): Promise<Release> {
  const existing = await releases.getReleaseByVersion(projectId, version);
  if (existing) return existing;
  const release: Release = {
    id: ids.next() as ReleaseId,
    projectId,
    version,
    createdAt: clock.now(),
  };
  try {
    await releases.put(release);
    return release;
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const winner = await releases.getReleaseByVersion(projectId, version);
    if (!winner) throw error;
    return winner;
  }
}

export type AssembleState =
  | "created"
  | "assembling"
  | "ok"
  | "error"
  | "not_found";
export interface AssembleResult {
  state: AssembleState;
  missingChunks: string[];
  detail?: string;
}
export interface AssembleRequest {
  orgId: OrgId;
  /** Projects of the organization, already resolved and authorized by the caller. */
  projectIds: readonly ProjectId[];
  checksum: string;
  chunks: readonly string[];
  version?: string;
  dist?: string;
}

export interface ArtifactBundleServiceOptions {
  releases: ReleaseRepo;
  blobs: BlobStore;
  clock: Clock;
  ids: IdGen;
  limits?: Partial<ChunkUploadLimits>;
}

/**
 * Chunk storage and synchronous bundle assembly.
 *
 * Assembly runs inside the request that asks for it. It reads at most `maxFileSize` bytes,
 * inflates only `manifest.json` and issues one store call per 100 debug IDs, which fits any
 * request time limit this stack targets at the advertised sizes; the `assembling` and `created`
 * states are therefore never returned. It is idempotent and resumable: every step is
 * repeatable: the bundle id is the checksum, and a retry adopts the stored pending row.
 */
export class ArtifactBundleService {
  readonly limits: ChunkUploadLimits;
  constructor(private readonly options: ArtifactBundleServiceOptions) {
    this.limits = { ...DEFAULT_CHUNK_UPLOAD_LIMITS, ...options.limits };
  }

  /** Store one chunk after the caller verified `sha1` against `data`. Idempotent. */
  async putChunk(orgId: OrgId, sha1: string, data: Uint8Array): Promise<void> {
    if (!isSha1(sha1)) throw new BundleRejectedError("Invalid chunk checksum");
    if (data.length > this.limits.chunkSize)
      throw new BundleRejectedError("Chunk exceeds the chunk size");
    const key = chunkKey(orgId, sha1);
    const head = await this.options.blobs.head(key);
    if (head?.size === data.length) return;
    await this.options.blobs.put(key, data, { size: data.length });
  }

  async assemble(request: AssembleRequest): Promise<AssembleResult> {
    const { blobs } = this.options;
    const { limits } = this;
    if (!isSha1(request.checksum) || !request.chunks.every(isSha1))
      return fail("Invalid checksum");
    if (!request.chunks.length) return fail("No chunks");
    if (
      request.chunks.length > Math.ceil(limits.maxFileSize / limits.chunkSize)
    )
      return fail("Bundle exceeds the maximum file size");
    if (!request.projectIds.length) return fail("No project");
    // The release named by the request exists whatever happens next, so a re-upload of an
    // identical bundle under a new `--release` still creates it.
    const releases = new Map<ProjectId, ReleaseId>();
    for (const projectId of request.projectIds)
      if (request.version) {
        const release = await ensureRelease(
          this.options.releases,
          this.options.ids,
          this.options.clock,
          projectId,
          request.version,
        );
        releases.set(projectId, release.id);
      }
    const active = await Promise.all(
      request.projectIds.map(async (id) => {
        const bundle = await this.options.releases.getBundle(
          id,
          request.checksum as ArtifactBundleId,
        );
        return bundle?.state === "active";
      }),
    );
    if (active.every(Boolean)) return { state: "ok", missingChunks: [] };

    const unique = [...new Set(request.chunks)];
    const sizes = new Map<string, number>();
    const missing: string[] = [];
    for (const sha1 of unique) {
      const head = await blobs.head(chunkKey(request.orgId, sha1));
      if (head) sizes.set(sha1, head.size);
      else missing.push(sha1);
    }
    if (missing.length) return { state: "not_found", missingChunks: missing };
    let total = 0;
    for (const sha1 of request.chunks) total += sizes.get(sha1) ?? 0;
    if (total > limits.maxFileSize)
      return fail("Bundle exceeds the maximum file size");

    const data = new Uint8Array(total);
    let offset = 0;
    for (const sha1 of request.chunks) {
      const stream = await blobs.get(chunkKey(request.orgId, sha1));
      if (!stream) return { state: "not_found", missingChunks: [sha1] };
      const chunk = await readBounded(stream, limits.chunkSize);
      if (offset + chunk.length > total) return fail("Chunk size changed");
      data.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== total) return fail("Chunk size changed");
    // Failures that depend only on the bytes will repeat on a retry, so their chunks go now;
    // anything transient keeps them for the retry.
    const dropChunks = () =>
      Promise.all(
        unique.map((sha1) =>
          blobs.delete(chunkKey(request.orgId, sha1)).catch(() => undefined),
        ),
      );
    if ((await sha1Hex(data)) !== request.checksum) {
      await dropChunks();
      return fail("Checksum does not match the uploaded chunks");
    }
    try {
      const parsed = parseArtifactBundle(data, limits);
      for (const projectId of request.projectIds)
        await this.register(
          projectId,
          request,
          data,
          parsed,
          releases.get(projectId) ?? UNRELEASED,
        );
    } catch (error) {
      if (error instanceof BundleRejectedError) {
        await dropChunks();
        return fail(error.message);
      }
      if (error instanceof ConflictError) return fail(error.message);
      throw error;
    }
    // Chunks are only inputs; a failed delete just leaves them for the lifecycle rule.
    await dropChunks();
    return { state: "ok", missingChunks: [] };
  }

  private async register(
    projectId: ProjectId,
    request: AssembleRequest,
    data: Uint8Array,
    parsed: ParsedBundle,
    releaseId: ReleaseId,
  ): Promise<void> {
    const { releases, blobs, clock } = this.options;
    const id = request.checksum as ArtifactBundleId;
    const digest = await bundleDebugIdsDigest(parsed.debugIds);
    // The same debug IDs are already served by an active bundle (a re-upload of one build).
    const owner = await releases.findBundleByDebugId(
      projectId,
      parsed.debugIds[0] as string,
    );
    if (owner?.manifest.digest === digest) return;

    let bundle = await releases.getBundle(projectId, id);
    if (bundle?.state === "active") return;
    if (
      bundle &&
      (bundle.cleanupStarted ||
        (bundle.pendingExpiresAt && bundle.pendingExpiresAt <= clock.now()))
    ) {
      // An expired attempt may be claimed by the cleanup cron at any moment; finish its cleanup
      // (claiming is atomic, so both run the same resumable steps) and start afresh.
      await cleanupPendingBundle(releases, blobs, projectId, id, clock.now());
      bundle = await releases.getBundle(projectId, id);
      if (bundle)
        throw new ConflictError("Previous attempt is being cleaned up; retry");
    }

    const body = new TextEncoder().encode(JSON.stringify(parsed.debugIds));
    if (!bundle) {
      const pendingExpiresAt = toTimestamp(
        new Date(Date.parse(clock.now()) + PENDING_BUNDLE_TTL_MS),
      );
      const manifest = {
        blobKey: manifestBlobKey(projectId, request.checksum, pendingExpiresAt),
        digest,
        debugIdCount: parsed.debugIds.length,
      };
      const created: ArtifactBundle = {
        id,
        projectId,
        releaseId,
        blobKey: bundleBlobKey(projectId, request.checksum),
        state: "pending",
        manifest,
        pendingExpiresAt,
      };
      await blobs.put(manifest.blobKey, body, {
        contentType: "application/json",
      });
      try {
        await releases.beginBundle(created, manifest);
        bundle = created;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        // A concurrent first attempt won with its own expiry and manifest key: adopt its row
        // and drop the manifest this attempt wrote.
        bundle = await releases.getBundle(projectId, id);
        if (bundle?.state !== "pending") throw error;
        if (bundle.manifest.blobKey !== manifest.blobKey)
          await blobs.delete(manifest.blobKey).catch(() => undefined);
      }
    }
    if (bundle.manifest.digest !== digest)
      throw new ConflictError("Bundle manifest does not match the upload");
    // Adopted rows carry their own keys; every write below is idempotent.
    await blobs.put(bundle.blobKey, data, { size: data.length });
    await blobs.put(bundle.manifest.blobKey, body, {
      contentType: "application/json",
    });
    for (let i = 0; i < parsed.debugIds.length; i += 100)
      await releases.putBundleDebugIds(
        projectId,
        id,
        parsed.debugIds.slice(i, i + 100),
        parsed.debugIds,
      );
    await releases.verifyAndActivateBundle(projectId, id, parsed.debugIds);
  }
}

function fail(detail: string): AssembleResult {
  return { state: "error", missingChunks: [], detail };
}
