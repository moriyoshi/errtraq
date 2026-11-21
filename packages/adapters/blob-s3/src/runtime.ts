import {
  BlobCorruptError,
  type BlobMetadata,
  type BlobStore,
  type CreateContext,
  type Cursor,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  pageLimit,
} from "@errtraq/core";
import { AwsV4Signer } from "aws4fetch";
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
}
export async function signS3Request(
  input: ConstructorParameters<typeof AwsV4Signer>[0],
) {
  return new AwsV4Signer(input).sign();
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
  if (expected === undefined) return body;
  let count = 0;
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        count += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        if (count !== expected)
          throw new BlobCorruptError("S3 response length mismatch");
      },
    }),
  );
}
/** S3-compatible BlobStore. Streams are uploaded in bounded multipart chunks. */
export class S3BlobStore implements BlobStore {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
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
    this.fetcher = options.fetch ?? fetch;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  private url(key?: string, query?: Record<string, string>): URL {
    if (
      key !== undefined &&
      (!key ||
        key.split("/").some((segment) => segment === "." || segment === ".."))
    )
      throw new Error(
        "S3 key cannot be represented safely by Web URL handling",
      );
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
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const credentials = await this.options.credentials();
      if (!credentials.accessKeyId || !credentials.secretAccessKey)
        throw new Error("S3 credentials are missing");
      const signed = await signS3Request({
        method,
        url: url.toString(),
        headers,
        body: body as BodyInit | undefined,
        ...credentials,
        service: "s3",
        region: this.options.region,
      });
      try {
        const response = await this.fetcher(signed.url, {
          method,
          headers: signed.headers,
          body: body as BodyInit | undefined,
          redirect: "manual",
        });
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < 3
        ) {
          await response.body?.cancel();
          await this.sleep(50 * 2 ** attempt);
          continue;
        }
        return response;
      } catch (error) {
        last = error;
        if (attempt === 3) throw error;
        await this.sleep(50 * 2 ** attempt);
      }
    }
    throw last;
  }
  private async requireOk(response: Response, action: string): Promise<void> {
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`S3 ${action} failed (${response.status})`);
    }
  }
  private async missing(response: Response, key: string): Promise<boolean> {
    if (response.status === 404) {
      await response.body?.cancel();
      return true;
    }
    if (response.status !== 403) return false;
    await response.body?.cancel();
    const result = await this.listPage(key, undefined, 1);
    return !result.keys.includes(key);
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
    const init = await this.request(
      "POST",
      this.url(key, { uploads: "" }),
      metadata?.contentType ? { "content-type": metadata.contentType } : {},
    );
    await this.requireOk(init, "start multipart upload");
    const uploadId = record(
      parseXml(await init.text()).InitiateMultipartUploadResult,
    ).UploadId;
    if (typeof uploadId !== "string" || !uploadId)
      throw new BlobCorruptError("Missing multipart upload ID");
    const parts: string[] = [];
    let total = 0,
      used = 0;
    let buffer = new Uint8Array(PART_SIZE);
    const upload = async (chunk: Uint8Array) => {
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
    const reader = body.getReader();
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
          const length = Math.min(PART_SIZE - used, item.value.length - offset);
          buffer.set(item.value.subarray(offset, offset + length), used);
          used += length;
          offset += length;
          if (used === PART_SIZE) {
            await upload(buffer);
            buffer = new Uint8Array(PART_SIZE);
            used = 0;
          }
        }
      }
      if (metadata?.size !== undefined && metadata.size !== total)
        throw new Error("Size mismatch");
      if (total === 0) {
        const abort = await this.request("DELETE", this.url(key, { uploadId }));
        await this.requireOk(abort, "abort empty multipart upload");
        await abort.body?.cancel();
        await this.put(key, new Uint8Array(), metadata);
        return;
      }
      if (used > 0) await upload(buffer.subarray(0, used));
      const payload = `<CompleteMultipartUpload>${parts.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
      const complete = await this.request(
        "POST",
        this.url(key, { uploadId }),
        { "content-type": "application/xml" },
        payload,
      );
      await this.requireOk(complete, "complete multipart upload");
      const result = parseXml(await complete.text());
      if (result.Error || !result.CompleteMultipartUploadResult)
        throw new Error("S3 multipart completion failed");
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      try {
        const abort = await this.request("DELETE", this.url(key, { uploadId }));
        await abort.body?.cancel();
      } catch {
        /* Preserve the upload error. */
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
    if (await this.missing(response, key)) return null;
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
    if (await this.missing(response, key)) return null;
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
        return decodeURIComponent(key);
      } catch {
        throw new BlobCorruptError("Invalid encoded S3 key");
      }
    });
    return { keys, truncated: data.IsTruncated === "true" };
  }
  async list(prefix: string, cursor?: Cursor, limit?: number) {
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
