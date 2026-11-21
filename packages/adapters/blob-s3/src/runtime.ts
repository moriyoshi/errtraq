import {
  AwsRequestError,
  awsRequest,
  signAwsRequest,
} from "@errtraq/aws-signing";
import type {
  BlobMetadata,
  BlobStore,
  CreateContext,
  Cursor,
} from "@errtraq/core";
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
} from "@errtraq/core/blob";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Config } from "./stack.js";

type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};
type CredentialsProvider = () => Credentials | Promise<Credentials>;
export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials: CredentialsProvider;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  requestTimeoutMs?: number;
  overallTimeoutMs?: number;
  signal?: AbortSignal;
  bodyIdleTimeoutMs?: number;
  allowedPrefixes?: readonly string[];
}
export const signS3Request = signAwsRequest;
function compareUtf8(a: string, b: string): number {
  const left = new TextEncoder().encode(a),
    right = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return difference;
  }
  return left.length - right.length;
}
const PART_SIZE = 5 * 1024 * 1024;
const MAX_PARTS = 10000;
const xml = new XMLParser({
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === "Contents",
});
function parseXml(body: string): Record<string, unknown> {
  if (XMLValidator.validate(body) !== true)
    throw new BlobCorruptError("Invalid S3 XML response");
  const parsed: unknown = xml.parse(body);
  if (!parsed || typeof parsed !== "object")
    throw new BlobCorruptError("Invalid S3 XML response");
  return parsed as Record<string, unknown>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BlobCorruptError("Invalid S3 XML response");
  return value as Record<string, unknown>;
}
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}
function checkedStream(
  body: ReadableStream<Uint8Array>,
  expected: number | undefined,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let count = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          reader.releaseLock();
          if (expected !== undefined && count !== expected)
            controller.error(
              new BlobCorruptError("S3 response length mismatch"),
            );
          else controller.close();
        } else {
          count += item.value.byteLength;
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
/** S3-compatible BlobStore. Streams are uploaded in bounded multipart chunks. */
export class S3BlobStore implements BlobStore {
  private readonly endpoint: URL;
  private readonly requestTimeoutMs: number;
  private readonly bodyIdleTimeoutMs: number;
  private readonly allowedPrefixes: readonly string[];
  constructor(private readonly options: S3Options) {
    if (!options.bucket || !options.region)
      throw new Error("S3 bucket and region are required");
    this.endpoint = new URL(
      options.endpoint ?? `https://s3.${options.region}.amazonaws.com`,
    );
    if (
      !["http:", "https:"].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    )
      throw new Error("Invalid S3 endpoint");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.bodyIdleTimeoutMs = options.bodyIdleTimeoutMs ?? 30_000;
    if (
      ![this.requestTimeoutMs, this.bodyIdleTimeoutMs].every(
        (value) => Number.isInteger(value) && value > 0 && value <= 300_000,
      )
    )
      throw new RangeError("Invalid S3 timeout");
    this.allowedPrefixes = options.allowedPrefixes ?? [];
  }
  private checkKey(key: string): void {
    validateBlobKey(key);
    if (!this.allowedPrefixes.some((prefix) => key.startsWith(prefix)))
      throw new BlobAccessDeniedError(
        "S3 key is outside delivered blob purposes",
      );
  }
  private url(key?: string, query?: Record<string, string>): URL {
    if (key !== undefined) this.checkKey(key);
    const url = new URL(this.endpoint);
    const base = url.pathname.replace(/\/$/, "");
    const bucket = encodeURIComponent(this.options.bucket);
    if (this.options.forcePathStyle)
      url.pathname = `${base}/${bucket}${key === undefined ? "" : `/${key.split("/").map(encodeURIComponent).join("/")}`}`;
    else {
      url.hostname = `${this.options.bucket}.${url.hostname}`;
      url.pathname = `${base}${key === undefined ? "/" : `/${key.split("/").map(encodeURIComponent).join("/")}`}`;
    }
    for (const [name, value] of Object.entries(query ?? {}))
      url.searchParams.set(name, value);
    return url;
  }
  private async request(
    method: string,
    url: URL,
    headers: HeadersInit = {},
    body?: Uint8Array | string,
  ): Promise<Response> {
    const requestHeaders = new Headers(headers);
    if (body !== undefined) {
      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : body;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        bytes as Uint8Array<ArrayBuffer>,
      );
      requestHeaders.set(
        "x-amz-content-sha256",
        Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      );
    }
    try {
      return await awsRequest({
        service: "s3",
        region: this.options.region,
        url: url.toString(),
        method,
        headers: requestHeaders,
        body,
        credentials: this.options.credentials,
        protocol: "s3",
        allowHttpErrors: true,
        fetch: this.options.fetch,
        sleep: this.options.sleep,
        random: this.options.random,
        requestTimeoutMs: this.requestTimeoutMs,
        bodyIdleTimeoutMs: this.bodyIdleTimeoutMs,
        overallTimeoutMs: this.options.overallTimeoutMs,
        signal: this.options.signal,
        mapBodyError: (error) =>
          new BlobUnavailableError(error.message, error.code),
      });
    } catch (error) {
      if (error instanceof AwsRequestError)
        throw new BlobUnavailableError(error.message, error.code);
      throw error;
    }
  }

  private async error(response: Response, action: string): Promise<BlobError> {
    const status = response.status;
    const code = response.headers.get("x-amz-error-code") ?? undefined;
    await response.body?.cancel();
    return this.providerError(status, action, code);
  }
  private providerError(
    status: number,
    action: string,
    code?: string,
  ): BlobError {
    const message =
      status === 301 || status === 307
        ? `S3 ${action} failed (${status}): check the bucket region and endpoint`
        : `S3 ${action} failed (${status}${code ? `, ${code}` : ""})`;
    if (code === "NoSuchBucket")
      return new BlobBucketNotFoundError(message, code);
    if (status === 403 || code === "AccessDenied")
      return new BlobAccessDeniedError(message, code);
    if (status === 429 || code === "SlowDown" || code === "Throttling")
      return new BlobThrottledError(message, code);
    if (status === 412 || code === "PreconditionFailed")
      return new BlobPreconditionError(message, code);
    if (status >= 500 || status === 408)
      return new BlobUnavailableError(message, code);
    if (code === "InvalidArgument" || code === "InvalidObjectName")
      return new BlobInvalidKeyError(message, code);
    return new BlobError(message, code);
  }
  private async requireOk(response: Response, action: string): Promise<void> {
    if (!response.ok) throw await this.error(response, action);
  }
  private async missing(
    response: Response,
    key: string,
    action: "get" | "head",
  ): Promise<boolean> {
    if (response.status !== 404 && response.status !== 403) return false;
    const failure = await this.error(response, action);
    if (failure.providerCode === "NoSuchBucket") throw failure;
    if (response.status === 404) {
      if (
        failure.providerCode === "NoSuchKey" ||
        (action === "head" && !failure.providerCode)
      )
        return true;
      throw failure;
    }
    if (failure.providerCode && failure.providerCode !== "AccessDenied")
      throw failure;
    try {
      const result = await this.listPage(key, undefined, 1);
      if (!result.keys.includes(key)) return true;
    } catch {
      /* The original error is more informative than the disambiguation failure. */
    }
    throw failure;
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
    if (body instanceof Uint8Array) {
      if (metadata?.size !== undefined && metadata.size !== body.byteLength)
        throw new Error("Size mismatch");
      const response = await this.request(
        "PUT",
        this.url(key),
        metadata?.contentType ? { "content-type": metadata.contentType } : {},
        body,
      );
      await this.requireOk(response, "put");
      await response.body?.cancel();
      return;
    }
    this.checkKey(key);
    const reader = body.getReader();
    let uploadId: string | undefined;
    const parts: string[] = [];
    let total = 0,
      used = 0;
    let buffer = new Uint8Array(PART_SIZE);
    const upload = async (chunk: Uint8Array) => {
      if (!uploadId) {
        const init = await this.request(
          "POST",
          this.url(key, { uploads: "" }),
          metadata?.contentType ? { "content-type": metadata.contentType } : {},
        );
        await this.requireOk(init, "start multipart upload");
        const id = record(
          parseXml(await init.text()).InitiateMultipartUploadResult,
        ).UploadId;
        if (typeof id !== "string" || !id)
          throw new BlobCorruptError("Missing multipart upload ID");
        uploadId = id;
      }
      if (parts.length >= MAX_PARTS)
        throw new Error("S3 multipart upload exceeds 10000 parts");
      const response = await this.request(
        "PUT",
        this.url(key, { partNumber: String(parts.length + 1), uploadId }),
        {},
        chunk,
      );
      await this.requireOk(response, "upload part");
      const etag = response.headers.get("etag");
      await response.body?.cancel();
      if (!etag) throw new BlobCorruptError("Missing multipart ETag");
      parts.push(etag);
    };
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        if (!(item.value instanceof Uint8Array))
          throw new TypeError("Blob stream must yield bytes");
        total += item.value.byteLength;
        if (
          !Number.isSafeInteger(total) ||
          (metadata?.size !== undefined && total > metadata.size)
        )
          throw new Error("Size mismatch");
        for (let offset = 0; offset < item.value.length; ) {
          if (used === PART_SIZE) {
            await upload(buffer);
            buffer = new Uint8Array(PART_SIZE);
            used = 0;
          }
          const length = Math.min(PART_SIZE - used, item.value.length - offset);
          buffer.set(item.value.subarray(offset, offset + length), used);
          used += length;
          offset += length;
        }
      }
      if (metadata?.size !== undefined && metadata.size !== total)
        throw new Error("Size mismatch");
      if (!uploadId) {
        await this.put(key, buffer.subarray(0, used), metadata);
        return;
      }
      if (used) await upload(buffer.subarray(0, used));
      const payload = `<CompleteMultipartUpload>${parts.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const complete = await this.request(
        "POST",
        this.url(key, { uploadId }),
        { "content-type": "application/xml" },
        payload,
      );
      await this.requireOk(complete, "complete multipart upload");
      const result = parseXml(await complete.text());
      if (result.Error) {
        const code = record(result.Error).Code;
        throw this.providerError(
          200,
          "complete multipart upload",
          typeof code === "string" ? code : undefined,
        );
      }
      if (!result.CompleteMultipartUploadResult)
        throw new BlobError("S3 multipart completion failed");
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      if (uploadId) {
        try {
          const abort = await this.request(
            "DELETE",
            this.url(key, { uploadId }),
          );
          await this.requireOk(abort, "abort multipart upload");
          await abort.body?.cancel();
        } catch (abortError) {
          throw new AggregateError(
            [error, abortError],
            "S3 upload and multipart abort failed",
          );
        }
      }
      throw error;
    } finally {
      reader.releaseLock();
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
    const response = await this.request(
      "GET",
      this.url(key),
      range ? { range: `bytes=${range.offset}-${end}` } : {},
    );
    if (response.status === 416 && range) {
      await response.body?.cancel();
      return (await this.head(key)) ? emptyStream() : null;
    }
    if (await this.missing(response, key, "get")) return null;
    await this.requireOk(response, "get");
    if (range && response.status !== 206) {
      await response.body?.cancel();
      throw new BlobCorruptError("S3 ignored byte range");
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
        throw new BlobCorruptError("Invalid S3 content range");
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
      throw new BlobCorruptError("Invalid S3 content length");
    }
    return checkedStream(response.body ?? emptyStream(), expected);
  }
  async head(key: string): Promise<BlobMetadata | null> {
    const response = await this.request("HEAD", this.url(key));
    if (await this.missing(response, key, "head")) return null;
    await this.requireOk(response, "head");
    const length = response.headers.get("content-length");
    const size = length === null ? NaN : Number(length);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new BlobCorruptError("Invalid S3 content length");
    const contentType = response.headers.get("content-type");
    return { size, ...(contentType ? { contentType } : {}) };
  }
  private async listPage(
    prefix: string,
    startAfter: string | undefined,
    limit: number,
  ): Promise<{ keys: string[]; truncated: boolean }> {
    const params: Record<string, string> = {
      "list-type": "2",
      prefix,
      "max-keys": String(limit),
      "encoding-type": "url",
    };
    if (startAfter !== undefined) params["start-after"] = startAfter;
    const response = await this.request("GET", this.url(undefined, params));
    await this.requireOk(response, "list");
    const data = record(parseXml(await response.text()).ListBucketResult);
    const entries = data.Contents === undefined ? [] : data.Contents;
    if (!Array.isArray(entries))
      throw new BlobCorruptError("Invalid S3 listing");
    const keys = entries.map((entry) => {
      const key = record(entry).Key;
      if (typeof key !== "string")
        throw new BlobCorruptError("Invalid S3 listing key");
      if (data.EncodingType !== "url") return key;
      try {
        return decodeURIComponent(key.replaceAll("+", " "));
      } catch {
        throw new BlobCorruptError("Invalid encoded S3 key");
      }
    });
    return { keys, truncated: data.IsTruncated === "true" };
  }
  async list(prefix: string, cursor?: Cursor, limit?: number) {
    if (!this.allowedPrefixes.some((allowed) => prefix.startsWith(allowed)))
      throw new BlobAccessDeniedError(
        "S3 list prefix is outside delivered blob purposes",
      );
    const size = pageLimit(limit),
      scope = JSON.stringify(["blob", prefix]),
      decoded = decodeCursor(cursor, scope);
    if (
      decoded &&
      (decoded.length !== 1 ||
        typeof decoded[0] !== "string" ||
        !decoded[0].startsWith(prefix))
    )
      throw new InvalidCursorError("Invalid blob cursor");
    let after = decoded?.[0] as string | undefined;
    const items: string[] = [];
    let truncated = false;
    while (items.length < size) {
      const page = await this.listPage(
        prefix,
        after,
        Math.min(1000, size - items.length),
      );
      for (const key of page.keys) {
        if (
          !key.startsWith(prefix) ||
          (after !== undefined && compareUtf8(key, after) <= 0)
        )
          throw new BlobCorruptError(
            "S3 listing did not advance in UTF-8 order",
          );
        items.push(key);
        after = key;
      }
      truncated = page.truncated;
      if (!truncated || page.keys.length === 0) {
        if (truncated) throw new BlobCorruptError("S3 listing did not advance");
        break;
      }
      after = page.keys.at(-1);
    }
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        truncated && last !== undefined ? encodeCursor(scope, [last]) : null,
    };
  }
  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", this.url(key));
    await this.requireOk(response, "delete");
    await response.body?.cancel();
  }
  async presign(
    key: string,
    options: { method: "GET" | "PUT"; expiresInSec: number },
  ): Promise<string> {
    if (
      !Number.isSafeInteger(options.expiresInSec) ||
      options.expiresInSec < 1 ||
      options.expiresInSec > 604800
    )
      throw new RangeError("Invalid presign expiration");
    const url = this.url(key, {
      "X-Amz-Expires": String(options.expiresInSec),
    });
    const signed = await signS3Request({
      method: options.method,
      url: url.toString(),
      ...(await this.options.credentials()),
      service: "s3",
      region: this.options.region,
      signQuery: true,
    });
    return signed.url.toString();
  }
}
export function create({
  config,
  bindings,
  environment = {},
}: CreateContext<Config, Record<string, unknown>>): S3BlobStore {
  const bucket =
    bindings.ERRTRAQ_BLOB_BUCKET ?? bindings.ERRTRAQ_STAGING_BUCKET;
  if (typeof bucket !== "string" || !bucket)
    throw new Error("Missing S3 bucket binding");
  if (
    typeof bindings.ERRTRAQ_BLOB_BUCKET === "string" &&
    typeof bindings.ERRTRAQ_STAGING_BUCKET === "string" &&
    bindings.ERRTRAQ_BLOB_BUCKET !== bindings.ERRTRAQ_STAGING_BUCKET
  )
    throw new Error("S3 purpose bindings must share the same bucket");
  if (
    typeof bindings.ERRTRAQ_STAGING_BUCKET === "string" &&
    (typeof bindings.ERRTRAQ_STAGING_PREFIX !== "string" ||
      !bindings.ERRTRAQ_STAGING_PREFIX)
  )
    throw new Error("Missing S3 staging prefix binding");
  if (
    typeof bindings.ERRTRAQ_STAGING_BUCKET === "string" &&
    (typeof bindings.ERRTRAQ_STAGING_PREFIX !== "string" ||
      !/^[a-zA-Z0-9_-]+\/$/.test(bindings.ERRTRAQ_STAGING_PREFIX) ||
      ["envelopes/", "payloads/", "artifacts/"].includes(
        bindings.ERRTRAQ_STAGING_PREFIX,
      ))
  )
    throw new Error("Invalid S3 staging prefix binding");
  const value = (name: string): string | undefined => {
    const binding = bindings[name];
    return typeof binding === "string" ? binding : environment[name];
  };
  const region =
    config.region ?? value("AWS_REGION") ?? value("AWS_DEFAULT_REGION");
  if (!region) throw new Error("Missing S3 region (AWS_REGION)");
  return new S3BlobStore({
    bucket,
    region,
    endpoint: config.endpoint ?? value("AWS_ENDPOINT_URL_S3"),
    forcePathStyle: config.forcePathStyle,
    requestTimeoutMs: config.requestTimeoutMs,
    overallTimeoutMs: config.overallTimeoutMs,
    bodyIdleTimeoutMs: config.bodyIdleTimeoutMs,
    allowedPrefixes: [
      ...(typeof bindings.ERRTRAQ_BLOB_BUCKET === "string"
        ? ["envelopes/", "payloads/", "artifacts/"]
        : []),
      ...(typeof bindings.ERRTRAQ_STAGING_BUCKET === "string" &&
      typeof bindings.ERRTRAQ_STAGING_PREFIX === "string" &&
      bindings.ERRTRAQ_STAGING_PREFIX
        ? [bindings.ERRTRAQ_STAGING_PREFIX]
        : []),
    ],
    credentials: () => {
      const sessionToken = value("AWS_SESSION_TOKEN");
      return {
        accessKeyId: value("AWS_ACCESS_KEY_ID") ?? "",
        secretAccessKey: value("AWS_SECRET_ACCESS_KEY") ?? "",
        ...(sessionToken ? { sessionToken } : {}),
      };
    },
  });
}
