import type {
  BlobMetadata,
  BlobStore,
  CreateContext,
  Cursor,
} from "@moriyoshi/errtraq-core";
import {
  BlobAccessDeniedError,
  BlobBucketNotFoundError,
  BlobCorruptError,
  BlobError,
  BlobInvalidKeyError,
  BlobPreconditionError,
  BlobThrottledError,
  BlobUnavailableError,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  pageLimit,
  validateBlobKey,
} from "@moriyoshi/errtraq-core/blob";
import {
  type BlobSigner,
  createCredentials,
  GcpAuthError,
  hex,
  type TokenSource,
} from "@moriyoshi/errtraq-gcp-auth";
import { Crc32c } from "./crc32c.js";
import type { Config } from "./stack.js";

export const DEFAULT_ENDPOINT = "https://storage.googleapis.com";
const READ_WRITE_SCOPE =
  "https://www.googleapis.com/auth/devstorage.read_write";
/** Resumable chunks must be multiples of 256 KiB. */
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 5;
const MAX_PRESIGN_SEC = 604800;

export interface GcsOptions {
  bucket: string;
  /** JSON API root; default `https://storage.googleapis.com`. Overriding it is for emulators. */
  endpoint?: string;
  tokens: TokenSource;
  /** Needed only for `presign`; without it the store has no `presign` method. */
  signer?: BlobSigner;
  /** Host used in signed URLs; default `storage.googleapis.com`. */
  signedUrlOrigin?: string;
  fetch?: typeof fetch;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  requestTimeoutMs?: number;
  overallTimeoutMs?: number;
  signal?: AbortSignal;
  allowedPrefixes?: readonly string[];
  chunkSize?: number;
}

function compareUtf8(a: string, b: string): number {
  const left = new TextEncoder().encode(a),
    right = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return left.length - right.length;
}
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
/** RFC 3986 percent-encoding as V4 signing requires (encodeURIComponent leaves `!'()*`). */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
function objectPath(key: string): string {
  return key.split("/").map(rfc3986).join("/");
}
/** Verifies length and, for full reads, the CRC-32C GCS reports. */
function checkedStream(
  body: ReadableStream<Uint8Array>,
  expected: number | undefined,
  crc32c: string | undefined,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const crc = crc32c ? new Crc32c() : undefined;
  let count = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          reader.releaseLock();
          if (expected !== undefined && count !== expected)
            controller.error(
              new BlobCorruptError("GCS response length mismatch"),
            );
          else if (crc && crc.digestBase64() !== crc32c)
            controller.error(new BlobCorruptError("GCS CRC32C mismatch"));
          else controller.close();
        } else {
          count += item.value.byteLength;
          crc?.update(item.value);
          controller.enqueue(item.value);
        }
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

interface Send {
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Session URIs carry their own authority and need no bearer token. */
  auth?: boolean;
  /** Statuses that are an expected outcome and not an error. */
  accept?: readonly number[];
}
interface GcsFailure {
  status: number;
  reason?: string;
  message?: string;
}

/** BlobStore over the GCS JSON API. Objects are unconditionally overwritten, as the port requires. */
export class GcsBlobStore implements BlobStore {
  declare presign?: (
    key: string,
    options: { method: "GET" | "PUT"; expiresInSec: number },
  ) => Promise<string>;
  private readonly endpoint: URL;
  private readonly explicitEndpoint: boolean;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number;
  private readonly overallTimeoutMs: number;
  private readonly allowedPrefixes: readonly string[];
  private readonly chunkSize: number;
  constructor(private readonly options: GcsOptions) {
    if (!options.bucket) throw new Error("GCS bucket is required");
    this.explicitEndpoint = options.endpoint !== undefined;
    this.endpoint = new URL(options.endpoint ?? DEFAULT_ENDPOINT);
    if (
      !["http:", "https:"].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    )
      throw new Error("Invalid GCS endpoint");
    this.fetcher = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.overallTimeoutMs = options.overallTimeoutMs ?? 120_000;
    if (
      ![this.requestTimeoutMs, this.overallTimeoutMs].every(
        (value) => Number.isInteger(value) && value > 0 && value <= 300_000,
      )
    )
      throw new RangeError("Invalid GCS timeout");
    this.chunkSize = options.chunkSize ?? CHUNK_SIZE;
    if (this.chunkSize <= 0 || this.chunkSize % (256 * 1024))
      throw new RangeError("GCS chunk size must be a multiple of 256 KiB");
    this.allowedPrefixes = options.allowedPrefixes ?? [];
    if (options.signer) this.presign = (key, opts) => this.signUrl(key, opts);
  }
  private checkKey(key: string): void {
    validateBlobKey(key);
    if (!this.allowedPrefixes.some((prefix) => key.startsWith(prefix)))
      throw new BlobAccessDeniedError(
        "GCS key is outside delivered blob purposes",
      );
  }
  private bucketUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(this.endpoint);
    const base = url.pathname.replace(/\/$/, "");
    url.pathname = `${base}${path}`;
    for (const [name, value] of Object.entries(query ?? {}))
      url.searchParams.set(name, value);
    return url.toString();
  }
  private metaUrl(key?: string, query?: Record<string, string>): string {
    const bucket = rfc3986(this.options.bucket);
    if (key === undefined)
      return this.bucketUrl(`/storage/v1/b/${bucket}/o`, query);
    this.checkKey(key);
    return this.bucketUrl(
      `/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}`,
      query,
    );
  }
  private uploadUrl(query: Record<string, string>): string {
    return this.bucketUrl(
      `/upload/storage/v1/b/${rfc3986(this.options.bucket)}/o`,
      query,
    );
  }

  /** One HTTP exchange with retries on network errors, 408, 429 and 5xx. Only idempotent calls go through here. */
  private async send(
    method: string,
    url: string,
    init: Send = {},
  ): Promise<Response> {
    const deadline = this.clock() + this.overallTimeoutMs;
    let failure: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(
          200 * 2 ** (attempt - 1) * (0.5 + this.random() / 2),
          5000,
        );
        if (this.clock() + delay >= deadline) break;
        await this.sleep(delay);
      }
      this.options.signal?.throwIfAborted();
      const headers = new Headers(init.headers);
      if (init.auth !== false) {
        let token: string;
        try {
          token = await this.options.tokens.getAccessToken([READ_WRITE_SCOPE]);
        } catch (error) {
          throw this.authError(error);
        }
        if (token) headers.set("authorization", `Bearer ${token}`);
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("timeout")),
        this.requestTimeoutMs,
      );
      const abort = () => controller.abort(this.options.signal?.reason);
      this.options.signal?.addEventListener("abort", abort, { once: true });
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers,
          body: init.body as BodyInit | undefined,
          signal: controller.signal,
        });
      } catch (error) {
        if (this.options.signal?.aborted) throw error;
        failure = error;
        continue;
      } finally {
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", abort);
      }
      if (
        (response.status === 408 ||
          response.status === 429 ||
          response.status >= 500) &&
        !init.accept?.includes(response.status) &&
        attempt < MAX_ATTEMPTS - 1
      ) {
        await response.body?.cancel();
        failure = new BlobUnavailableError(
          `GCS responded ${response.status}`,
          String(response.status),
        );
        continue;
      }
      return response;
    }
    if (failure instanceof BlobError) throw failure;
    throw new BlobUnavailableError(
      `GCS request failed: ${failure instanceof Error ? failure.name : "unavailable"}`,
    );
  }
  private authError(error: unknown): Error {
    if (error instanceof GcpAuthError)
      return error.code === "denied" || error.code === "bad_key"
        ? new BlobAccessDeniedError(error.message, error.code)
        : new BlobUnavailableError(error.message, error.code);
    return error instanceof Error ? error : new Error(String(error));
  }
  private async failure(response: Response): Promise<GcsFailure> {
    const status = response.status;
    let reason: string | undefined, message: string | undefined;
    try {
      const body = (await response.json()) as {
        error?: { message?: unknown; errors?: { reason?: unknown }[] };
      };
      const r = body.error?.errors?.[0]?.reason;
      reason = typeof r === "string" ? r : undefined;
      message =
        typeof body.error?.message === "string"
          ? body.error.message
          : undefined;
    } catch {
      await response.body?.cancel().catch(() => {});
    }
    return { status, reason, message };
  }
  private providerError(f: GcsFailure, action: string): BlobError {
    const text = `GCS ${action} failed (${f.status}${f.reason ? `, ${f.reason}` : ""})`;
    if (f.status === 404 && this.bucketMissing(f))
      return new BlobBucketNotFoundError(text, f.reason);
    if (f.status === 429 || f.reason === "rateLimitExceeded")
      return new BlobThrottledError(text, f.reason);
    if (f.status === 401 || f.status === 403)
      return new BlobAccessDeniedError(text, f.reason);
    if (f.status === 412) return new BlobPreconditionError(text, f.reason);
    if (f.status >= 500 || f.status === 408)
      return new BlobUnavailableError(text, f.reason);
    if (f.status === 400 && /object name|invalid.*name/i.test(f.message ?? ""))
      return new BlobInvalidKeyError(text, f.reason);
    return new BlobError(text, f.reason);
  }
  /** A 404 names either a missing bucket or a missing object; only the message tells them apart. */
  private bucketMissing(f: GcsFailure): boolean {
    return /bucket/i.test(f.message ?? "") && !/object/i.test(f.message ?? "");
  }
  private async requireOk(response: Response, action: string): Promise<void> {
    if (!response.ok)
      throw this.providerError(await this.failure(response), action);
  }

  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    metadata?: { contentType?: string; size?: number },
  ): Promise<void> {
    if (
      metadata?.size !== undefined &&
      (!Number.isSafeInteger(metadata.size) || metadata.size < 0)
    )
      throw new RangeError("Invalid blob size");
    this.checkKey(key);
    const contentType = metadata?.contentType ?? "application/octet-stream";
    if (body instanceof Uint8Array) {
      if (metadata?.size !== undefined && metadata.size !== body.byteLength)
        throw new Error("Size mismatch");
      // A simple media upload overwrites unconditionally and is safe to retry.
      const response = await this.send(
        "POST",
        this.uploadUrl({ uploadType: "media", name: key }),
        { headers: { "content-type": contentType }, body },
      );
      await this.requireOk(response, "put");
      await response.body?.cancel();
      return;
    }
    await this.putStream(key, body, contentType, metadata?.size);
  }
  private async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    contentType: string,
    expectedSize: number | undefined,
  ): Promise<void> {
    const reader = body.getReader();
    const chunk = this.chunkSize;
    let session: string | undefined;
    let buffer = new Uint8Array(chunk);
    let used = 0;
    let sent = 0;
    let total = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        if (!(item.value instanceof Uint8Array))
          throw new TypeError("Blob stream must yield bytes");
        total += item.value.byteLength;
        if (
          !Number.isSafeInteger(total) ||
          (expectedSize !== undefined && total > expectedSize)
        )
          throw new Error("Size mismatch");
        for (let offset = 0; offset < item.value.length; ) {
          if (used === chunk) {
            session ??= await this.startSession(key, contentType, expectedSize);
            await this.uploadChunk(session, buffer, used, sent, undefined);
            sent += used;
            buffer = new Uint8Array(chunk);
            used = 0;
          }
          const length = Math.min(chunk - used, item.value.length - offset);
          buffer.set(item.value.subarray(offset, offset + length), used);
          used += length;
          offset += length;
        }
      }
      if (expectedSize !== undefined && expectedSize !== total)
        throw new Error("Size mismatch");
      if (!session) {
        await this.put(key, buffer.subarray(0, used), { contentType });
        return;
      }
      await this.uploadChunk(session, buffer, used, sent, total);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      if (session) await this.cancelSession(session);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  private sessionUrl(location: string): string {
    const url = new URL(location, this.endpoint);
    if (url.origin !== this.endpoint.origin) {
      // Emulators advertise their own public host; on real GCS an off-origin session is refused
      // so no request ever carries the upload authority to an unexpected host.
      if (!this.explicitEndpoint)
        throw new BlobCorruptError("Unexpected GCS upload session location");
      url.protocol = this.endpoint.protocol;
      url.host = this.endpoint.host;
    }
    return url.toString();
  }
  private async startSession(
    key: string,
    contentType: string,
    size: number | undefined,
  ): Promise<string> {
    const response = await this.send(
      "POST",
      this.uploadUrl({ uploadType: "resumable", name: key }),
      {
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": contentType,
          ...(size === undefined
            ? {}
            : { "x-upload-content-length": String(size) }),
        },
        body: JSON.stringify({ name: key, contentType }),
      },
    );
    await this.requireOk(response, "start resumable upload");
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) throw new BlobCorruptError("Missing GCS upload session");
    return this.sessionUrl(location);
  }
  /** Persisted byte count of a session, or "done" when the object already exists. */
  private async sessionStatus(session: string): Promise<number | "done"> {
    const response = await this.send("PUT", session, {
      headers: { "content-range": "bytes */*", "content-length": "0" },
      auth: false,
      accept: [308],
    });
    if (response.status === 308) {
      await response.body?.cancel();
      const range = response.headers.get("range")?.match(/^bytes=0-(\d+)$/);
      return range ? Number(range[1]) + 1 : 0;
    }
    if (response.ok) {
      await response.body?.cancel();
      return "done";
    }
    throw this.providerError(await this.failure(response), "resume upload");
  }
  private async uploadChunk(
    session: string,
    buffer: Uint8Array,
    used: number,
    start: number,
    finalTotal: number | undefined,
  ): Promise<void> {
    const end = start + used;
    let from = start;
    for (let round = 0; round < MAX_ATTEMPTS; round++) {
      const slice = buffer.subarray(from - start, used);
      const range =
        slice.length === 0
          ? `bytes */${finalTotal}`
          : `bytes ${from}-${end - 1}/${finalTotal ?? "*"}`;
      const response = await this.send("PUT", session, {
        headers: { "content-range": range },
        body: slice,
        auth: false,
        accept: [308],
      }).catch((error) => {
        if (error instanceof BlobUnavailableError) return undefined;
        throw error;
      });
      if (response?.status === 308 && finalTotal === undefined) {
        await response.body?.cancel();
        const persisted = response.headers
          .get("range")
          ?.match(/^bytes=0-(\d+)$/)?.[1];
        const next = persisted === undefined ? 0 : Number(persisted) + 1;
        if (next === end) return;
        if (next < start || next > end)
          throw new BlobCorruptError(
            "GCS reported an inconsistent upload offset",
          );
        from = next;
        continue;
      }
      if (response?.ok && finalTotal !== undefined) {
        await response.body?.cancel();
        return;
      }
      if (response && response.status !== 308 && !response.ok) {
        const f = await this.failure(response);
        if (f.status < 500 && f.status !== 408 && f.status !== 429)
          throw this.providerError(f, "upload chunk");
      } else if (response) await response.body?.cancel();
      // Transient failure or an unexpected answer: ask the server where it stands.
      const status = await this.sessionStatus(session);
      if (status === "done") {
        if (finalTotal !== undefined) return;
        throw new BlobCorruptError("GCS finalized an upload early");
      }
      if (status === end && finalTotal === undefined) return;
      if (status < start || status > end)
        throw new BlobCorruptError(
          "GCS reported an inconsistent upload offset",
        );
      from = status;
    }
    throw new BlobUnavailableError("GCS upload chunk failed repeatedly");
  }
  private async cancelSession(session: string): Promise<void> {
    try {
      const response = await this.send("DELETE", session, {
        auth: false,
        accept: [499],
      });
      await response.body?.cancel();
    } catch {
      /* The session expires on its own; the upload error is the useful one. */
    }
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length?: number } },
  ): Promise<ReadableStream<Uint8Array> | null> {
    const range = options?.range;
    if (
      range &&
      (!Number.isSafeInteger(range.offset) ||
        range.offset < 0 ||
        (range.length !== undefined &&
          (!Number.isSafeInteger(range.length) ||
            range.length < 0 ||
            !Number.isSafeInteger(range.offset + range.length))))
    )
      throw new RangeError("Invalid byte range");
    if (range?.length === 0)
      return (await this.head(key)) ? emptyStream() : null;
    const end =
      range?.length === undefined
        ? ""
        : String(range.offset + range.length - 1);
    const response = await this.send(
      "GET",
      this.metaUrl(key, { alt: "media" }),
      {
        headers: {
          // Identity encoding keeps byte counts and checksums meaningful.
          "accept-encoding": "identity",
          ...(range ? { range: `bytes=${range.offset}-${end}` } : {}),
        },
        accept: [416],
      },
    );
    if (response.status === 416 && range) {
      await response.body?.cancel();
      return (await this.head(key)) ? emptyStream() : null;
    }
    if (response.status === 404) {
      const f = await this.failure(response);
      if (this.bucketMissing(f)) throw this.providerError(f, "get");
      return null;
    }
    await this.requireOk(response, "get");
    if (range && response.status !== 206) {
      await response.body?.cancel();
      throw new BlobCorruptError("GCS ignored byte range");
    }
    let rangeBytes: number | undefined;
    if (range) {
      const contentRange = response.headers
        .get("content-range")
        ?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
      const first = Number(contentRange?.[1]);
      const last = Number(contentRange?.[2]);
      const total =
        contentRange?.[3] === "*" ? undefined : Number(contentRange?.[3]);
      if (
        !contentRange ||
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        first !== range.offset ||
        last < first ||
        (range.length !== undefined && last >= range.offset + range.length) ||
        (total !== undefined && (!Number.isSafeInteger(total) || last >= total))
      ) {
        await response.body?.cancel();
        throw new BlobCorruptError("Invalid GCS content range");
      }
      rangeBytes = last - first + 1;
    }
    const length = response.headers.get("content-length");
    const expected = length === null ? rangeBytes : Number(length);
    if (
      expected !== undefined &&
      (!Number.isSafeInteger(expected) ||
        expected < 0 ||
        (rangeBytes !== undefined && expected !== rangeBytes))
    ) {
      await response.body?.cancel();
      throw new BlobCorruptError("Invalid GCS content length");
    }
    const crc32c = range
      ? undefined
      : response.headers
          .get("x-goog-hash")
          ?.split(",")
          .map((part) => part.trim())
          .find((part) => part.startsWith("crc32c="))
          ?.slice("crc32c=".length);
    return checkedStream(response.body ?? emptyStream(), expected, crc32c);
  }
  async head(key: string): Promise<BlobMetadata | null> {
    // Object metadata (not HTTP HEAD): its error body tells a missing object from a missing bucket.
    const response = await this.send(
      "GET",
      this.metaUrl(key, { fields: "size,contentType" }),
    );
    if (response.status === 404) {
      const f = await this.failure(response);
      if (this.bucketMissing(f)) throw this.providerError(f, "head");
      return null;
    }
    await this.requireOk(response, "head");
    const meta = (await response.json().catch(() => null)) as {
      size?: unknown;
      contentType?: unknown;
    } | null;
    const size = Number(meta?.size);
    if (!meta || !Number.isSafeInteger(size) || size < 0)
      throw new BlobCorruptError("Invalid GCS object size");
    return {
      size,
      ...(typeof meta.contentType === "string" && meta.contentType
        ? { contentType: meta.contentType }
        : {}),
    };
  }
  private async listPage(
    prefix: string,
    pageToken: string | undefined,
    limit: number,
  ): Promise<{ keys: string[]; next: string | undefined }> {
    const response = await this.send(
      "GET",
      this.metaUrl(undefined, {
        prefix,
        maxResults: String(limit),
        fields: "items(name),nextPageToken",
        ...(pageToken === undefined ? {} : { pageToken }),
      }),
    );
    await this.requireOk(response, "list");
    const body = (await response.json().catch(() => null)) as {
      items?: { name?: unknown }[];
      nextPageToken?: unknown;
    } | null;
    if (!body || (body.items !== undefined && !Array.isArray(body.items)))
      throw new BlobCorruptError("Invalid GCS listing");
    const keys = (body.items ?? []).map((item) => {
      if (typeof item.name !== "string")
        throw new BlobCorruptError("Invalid GCS listing key");
      return item.name;
    });
    const next =
      typeof body.nextPageToken === "string" && body.nextPageToken
        ? body.nextPageToken
        : undefined;
    return { keys, next };
  }
  async list(prefix: string, cursor?: Cursor, limit?: number) {
    if (!this.allowedPrefixes.some((allowed) => prefix.startsWith(allowed)))
      throw new BlobAccessDeniedError(
        "GCS list prefix is outside delivered blob purposes",
      );
    const size = pageLimit(limit),
      scope = JSON.stringify(["blob", prefix]),
      decoded = decodeCursor(cursor, scope);
    if (decoded && (decoded.length !== 1 || typeof decoded[0] !== "string"))
      throw new InvalidCursorError("Invalid blob cursor");
    let token = decoded?.[0] as string | undefined;
    const items: string[] = [];
    let last: string | undefined;
    // Each GCS page is requested for exactly the keys still wanted, so a page token always
    // resumes right after the last key returned and can be the port's opaque cursor.
    while (items.length < size) {
      const page = await this.listPage(
        prefix,
        token,
        Math.min(1000, size - items.length),
      );
      for (const key of page.keys) {
        if (
          !key.startsWith(prefix) ||
          (last !== undefined && compareUtf8(key, last) <= 0)
        )
          throw new BlobCorruptError(
            "GCS listing did not advance in UTF-8 order",
          );
        items.push(key);
        last = key;
      }
      if (page.next === undefined) {
        token = undefined;
        break;
      }
      if (page.next === token)
        throw new BlobCorruptError("GCS listing did not advance");
      token = page.next;
    }
    return {
      items,
      nextCursor: token === undefined ? null : encodeCursor(scope, [token]),
    };
  }
  async delete(key: string): Promise<void> {
    const response = await this.send("DELETE", this.metaUrl(key), {
      accept: [404],
    });
    if (response.status === 404) {
      const f = await this.failure(response);
      if (this.bucketMissing(f)) throw this.providerError(f, "delete");
      return;
    }
    await this.requireOk(response, "delete");
    await response.body?.cancel();
  }

  /** V4 signed URL (`GOOG4-RSA-SHA256`, unsigned payload, host header only). */
  private async signUrl(
    key: string,
    options: { method: "GET" | "PUT"; expiresInSec: number },
  ): Promise<string> {
    this.checkKey(key);
    if (
      !Number.isSafeInteger(options.expiresInSec) ||
      options.expiresInSec < 1 ||
      options.expiresInSec > MAX_PRESIGN_SEC
    )
      throw new RangeError("Invalid presign expiration");
    const signer = this.options.signer as BlobSigner;
    const origin = new URL(
      this.options.signedUrlOrigin ??
        (this.explicitEndpoint ? this.endpoint.origin : DEFAULT_ENDPOINT),
    );
    let email: string;
    try {
      email =
        typeof signer.email === "string" ? signer.email : await signer.email();
    } catch (error) {
      throw this.authError(error);
    }
    const stamp = new Date(this.clock())
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
    const scope = `${stamp.slice(0, 8)}/auto/storage/goog4_request`;
    const query: [string, string][] = [
      ["X-Goog-Algorithm", "GOOG4-RSA-SHA256"],
      ["X-Goog-Credential", `${email}/${scope}`],
      ["X-Goog-Date", stamp],
      ["X-Goog-Expires", String(options.expiresInSec)],
      ["X-Goog-SignedHeaders", "host"],
    ];
    const canonicalQuery = query
      .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const path = `${origin.pathname.replace(/\/$/, "")}/${rfc3986(this.options.bucket)}/${objectPath(key)}`;
    const canonicalRequest = [
      options.method,
      path,
      canonicalQuery,
      `host:${origin.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalRequest),
    );
    const stringToSign = [
      "GOOG4-RSA-SHA256",
      stamp,
      scope,
      hex(new Uint8Array(digest)),
    ].join("\n");
    let signature: Uint8Array;
    try {
      signature = await signer.sign(new TextEncoder().encode(stringToSign));
    } catch (error) {
      throw this.authError(error);
    }
    return `${origin.origin}${path}?${canonicalQuery}&X-Goog-Signature=${hex(signature)}`;
  }
}

export function create({
  config,
  bindings,
  environment = {},
  secretSource,
}: CreateContext<Config, Record<string, unknown>>): GcsBlobStore {
  const bucket = bindings.ERRTRAQ_BLOB_BUCKET;
  if (typeof bucket !== "string" || !bucket)
    throw new Error("Missing GCS bucket binding");
  const auth = config.auth ?? { mode: "metadata" as const };
  if (auth.mode === "none" && !config.endpoint)
    throw new Error("GCS auth mode none requires an endpoint override");
  const lazy = lazyCredentials(auth, environment, secretSource);
  return new GcsBlobStore({
    bucket,
    endpoint: config.endpoint,
    tokens: lazy.tokens,
    ...(auth.mode === "static" || auth.mode === "none"
      ? {}
      : { signer: lazy.signer }),
    requestTimeoutMs: config.requestTimeoutMs,
    overallTimeoutMs: config.overallTimeoutMs,
    // Same prefixes as blob-s3: `archive-overflow/` holds the archive worker's batch manifests
    // (the staging purpose was dropped in M4b).
    allowedPrefixes: [
      "envelopes/",
      "payloads/",
      "artifacts/",
      "archive-overflow/",
    ],
  });
}
type Auth = NonNullable<Config["auth"]>;
/**
 * Credentials resolved on first use: a service account key is read from the secret source only
 * when a token or signature is first needed, never at construction.
 */
function lazyCredentials(
  auth: Auth,
  environment: Readonly<Record<string, string | undefined>>,
  secretSource: CreateContext["secretSource"],
): { tokens: TokenSource; signer: BlobSigner } {
  let resolved: Promise<ReturnType<typeof createCredentials>> | undefined;
  const credentials = () => {
    resolved ??= (async () => {
      switch (auth.mode) {
        case "metadata":
          return createCredentials({
            mode: "metadata",
            host: auth.host ?? environment.GCE_METADATA_HOST,
          });
        case "service-account": {
          if (!secretSource)
            throw new Error("GCS service-account auth needs a secret source");
          return createCredentials({
            mode: "service-account",
            key: await secretSource.read(auth.keySecretId),
          });
        }
        case "static":
          return createCredentials({
            mode: "static",
            token: environment[auth.tokenEnv] ?? "",
          });
        case "none":
          return createCredentials({ mode: "none" });
      }
    })().catch((error) => {
      resolved = undefined;
      throw error;
    });
    return resolved;
  };
  return {
    tokens: {
      getAccessToken: async (scopes) =>
        (await credentials()).tokens.getAccessToken(scopes),
      getIdToken: async (audience) =>
        (await credentials()).tokens.getIdToken(audience),
    },
    signer: {
      email: async () => {
        const signer = (await credentials()).signer;
        if (!signer) throw new Error("GCS credentials cannot sign");
        return typeof signer.email === "string" ? signer.email : signer.email();
      },
      sign: async (payload) => {
        const signer = (await credentials()).signer;
        if (!signer) throw new Error("GCS credentials cannot sign");
        return signer.sign(payload);
      },
    },
  };
}
