import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  BlobCorruptError,
  type BlobStore,
  type CreateContext,
  type Cursor,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  type Logger,
  pageLimit,
  validateBlobKey,
} from "@moriyoshi/errtraq-core";
import { type BlobConfig, configSchema } from "./stack.js";

export { infra, manifest } from "./stack.js";

interface Header {
  key: string;
  contentType?: string;
  size?: string;
}
const hashKey = (key: string) =>
  `object-${createHash("sha256").update(key, "utf16le").digest("hex")}`;
const noFollow = constants.O_RDONLY | constants.O_NOFOLLOW;
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
function lowerBound(keys: string[], value: string): number {
  let lo = 0,
    hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const key = keys[mid];
    if (key !== undefined && compareUtf8(key, value) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
async function syncDirectory(root: string) {
  const directory = await open(root, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readHeader(
  file: FileHandle,
): Promise<{ header: Header; offset: number }> {
  try {
    const lengthBytes = Buffer.alloc(4);
    if ((await file.read(lengthBytes, 0, 4, 0)).bytesRead !== 4)
      throw new Error("Invalid blob header");
    const length = lengthBytes.readUInt32BE();
    if (length > 1024 * 1024) throw new Error("Blob header too large");
    const payload = Buffer.alloc(length);
    if ((await file.read(payload, 0, length, 4)).bytesRead !== length)
      throw new Error("Truncated blob header");
    const header = JSON.parse(payload.toString("utf8")) as Header;
    const offset = 4 + length;
    const info = await file.stat();
    if (
      !header ||
      typeof header.key !== "string" ||
      (header.contentType !== undefined &&
        typeof header.contentType !== "string") ||
      (header.size !== undefined &&
        (!/^\d{16}$/.test(header.size) ||
          Number(header.size) !== info.size - offset))
    )
      throw new Error("Corrupt blob data");
    return { header, offset };
  } catch (error) {
    throw new BlobCorruptError(`Invalid blob: ${String(error)}`);
  }
}
function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Single-process index: external writers require reopening the adapter. Keys use flat hashes. */
export class FsBlobStore implements BlobStore {
  private root: Promise<string>;
  private readonly keys: string[] = [];
  private readonly expiryCursors = new Map<string, string>();
  constructor(
    config: BlobConfig,
    logger: Pick<Logger, "warn"> = {
      warn: (message, fields) => console.warn(message, fields),
    },
    openForScan: typeof open = open,
  ) {
    const { root } = configSchema.parse(config);
    this.root = (async () => {
      await mkdir(root, { recursive: true });
      const canonical = await realpath(root);
      const entries = await readdir(canonical, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(canonical, entry.name);
        if (entry.isFile() && entry.name.startsWith(".tmp-")) {
          const info = await stat(path);
          if (Date.now() - info.mtimeMs > 3600000) await unlink(path);
          continue;
        }
        if (!entry.isFile() || !/^object-[a-f0-9]{64}$/.test(entry.name))
          continue;
        let file: FileHandle | undefined;
        try {
          file = await openForScan(path, noFollow);
          const { header } = await readHeader(file);
          if (hashKey(header.key) !== entry.name)
            throw new BlobCorruptError("Blob key mismatch");
          this.keys.push(header.key);
        } catch (error) {
          if (!missing(error))
            logger.warn("Skipping unreadable blob", {
              path,
              error: String(error),
            });
        } finally {
          await file?.close();
        }
      }
      this.keys.sort(compareUtf8);
      return canonical;
    })();
  }
  private insertKey(key: string) {
    const i = lowerBound(this.keys, key);
    if (this.keys[i] !== key) this.keys.splice(i, 0, key);
  }
  private removeKey(key: string) {
    const i = lowerBound(this.keys, key);
    if (this.keys[i] === key) this.keys.splice(i, 1);
  }
  private async path(key: string) {
    return join(await this.root, hashKey(key));
  }
  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    metadata?: { contentType?: string; size?: number },
  ): Promise<void> {
    validateBlobKey(key);
    const root = await this.root;
    const temp = join(root, `.tmp-${randomUUID()}`);
    const target = await this.path(key);
    const header: Header = {
      key,
      size: "0000000000000000",
      ...(metadata?.contentType === undefined
        ? {}
        : { contentType: metadata.contentType }),
    };
    const json = Buffer.from(JSON.stringify(header));
    if (json.length > 1024 * 1024) throw new Error("Blob header too large");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(json.length);
    const file = await open(
      temp,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    let size = 0;
    let position = 0;
    async function writeAll(data: Uint8Array) {
      let offset = 0;
      while (offset < data.byteLength) {
        const result = await file.write(
          data,
          offset,
          data.byteLength - offset,
          position,
        );
        if (!result.bytesWritten) throw new Error("Short blob write");
        offset += result.bytesWritten;
        position += result.bytesWritten;
      }
    }
    try {
      await writeAll(prefix);
      await writeAll(json);
      if (body instanceof Uint8Array) {
        await writeAll(body);
        size = body.byteLength;
      } else {
        const reader = body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            await writeAll(chunk.value);
            size += chunk.value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
      }
      if (metadata?.size !== undefined && size !== metadata.size)
        throw new Error("Size mismatch");
      const finalHeader = Buffer.from(
        JSON.stringify({ ...header, size: String(size).padStart(16, "0") }),
      );
      if (finalHeader.length !== json.length)
        throw new Error("Blob size too large");
      let written = 0;
      while (written < finalHeader.length) {
        const result = await file.write(
          finalHeader,
          written,
          finalHeader.length - written,
          4 + written,
        );
        if (!result.bytesWritten) throw new Error("Short blob header write");
        written += result.bytesWritten;
      }
      await file.sync();
      await file.close();
      await rename(temp, target);
      this.insertKey(key);
      await syncDirectory(root);
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  async get(
    key: string,
    options?: { range?: { offset: number; length?: number } },
  ): Promise<ReadableStream<Uint8Array> | null> {
    validateBlobKey(key);
    const range = options?.range;
    if (
      range &&
      (!Number.isSafeInteger(range.offset) ||
        range.offset < 0 ||
        (range.length !== undefined &&
          (!Number.isSafeInteger(range.length) || range.length < 0)))
    )
      throw new RangeError("Invalid byte range");
    let file: FileHandle;
    try {
      file = await open(await this.path(key), noFollow);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      const { header, offset } = await readHeader(file);
      if (header.key !== key) throw new BlobCorruptError("Blob key mismatch");
      const stat = await file.stat();
      const begin = Math.min(stat.size, offset + (range?.offset ?? 0));
      let position = begin;
      let remaining = Math.min(
        stat.size - begin,
        range?.length ?? Number.MAX_SAFE_INTEGER,
      );
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (remaining <= 0) {
              await file.close();
              controller.close();
              return;
            }
            const chunk = new Uint8Array(Math.min(remaining, 65536));
            const read = await file.read(chunk, 0, chunk.length, position);
            if (read.bytesRead === 0) {
              await file.close();
              controller.close();
              return;
            }
            position += read.bytesRead;
            remaining -= read.bytesRead;
            controller.enqueue(chunk.subarray(0, read.bytesRead));
          } catch (error) {
            await file.close();
            controller.error(error);
          }
        },
        async cancel() {
          await file.close();
        },
      });
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async head(key: string) {
    validateBlobKey(key);
    let file: FileHandle;
    try {
      file = await open(await this.path(key), noFollow);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      const { header, offset } = await readHeader(file);
      if (header.key !== key) throw new BlobCorruptError("Blob key mismatch");
      const stat = await file.stat();
      return {
        size: stat.size - offset,
        ...(header.contentType === undefined
          ? {}
          : { contentType: header.contentType }),
      };
    } finally {
      await file.close();
    }
  }
  async list(prefix: string, cursor?: Cursor, limit?: number) {
    await this.root;
    const size = pageLimit(limit);
    const scope = JSON.stringify(["blob", prefix]);
    const after = decodeCursor(cursor, scope);
    if (after && (after.length !== 1 || typeof after[0] !== "string"))
      throw new InvalidCursorError("Invalid blob cursor");
    if (after && !String(after[0]).startsWith(prefix))
      throw new InvalidCursorError("Blob cursor outside prefix");
    const start = after
      ? lowerBound(this.keys, after[0] as string)
      : lowerBound(this.keys, prefix);
    let i = start;
    if (after && this.keys[i] === after[0]) i++;
    const rows: string[] = [];
    while (i < this.keys.length && rows.length <= size) {
      const key = this.keys[i++];
      if (key === undefined || !key.startsWith(prefix)) break;
      rows.push(key);
    }
    const items = rows.slice(0, size);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > size && last !== undefined
          ? encodeCursor(scope, [last])
          : null,
    };
  }

  /**
   * Delete objects under `prefix` last written before `olderThan` (an ISO timestamp) and return
   * how many were removed. blob-fs has no lifecycle rules, so the standalone `bundle-cleanup` job
   * uses this to expire abandoned `artifacts/chunks/` uploads. Work per call is bounded: at most
   * `scanLimit` keys are examined (default 2000), continuing after the last key of the previous
   * call for the same prefix and wrapping to the start at the end, so fresh keys sorted first
   * never starve older ones. The cursor lives in this process (the standalone platform is one).
   */
  async expireOlderThan(
    prefix: string,
    olderThan: string,
    options: { scanLimit?: number } = {},
  ): Promise<number> {
    const cutoff = Date.parse(olderThan);
    if (!Number.isFinite(cutoff)) throw new RangeError("Invalid expiry time");
    const scanLimit = options.scanLimit ?? 2000;
    if (!Number.isSafeInteger(scanLimit) || scanLimit < 1)
      throw new RangeError("Invalid scan limit");
    await this.root;
    const after = this.expiryCursors.get(prefix);
    let i = lowerBound(this.keys, after ?? prefix);
    if (after !== undefined && this.keys[i] === after) i++;
    const candidates: string[] = [];
    let exhausted = true;
    for (; i < this.keys.length; i++) {
      const key = this.keys[i];
      if (key === undefined || !key.startsWith(prefix)) break;
      if (candidates.length >= scanLimit) {
        exhausted = false;
        break;
      }
      candidates.push(key);
    }
    const last = candidates.at(-1);
    if (exhausted || last === undefined) this.expiryCursors.delete(prefix);
    else this.expiryCursors.set(prefix, last);
    let removed = 0;
    for (const key of candidates) {
      try {
        const info = await stat(await this.path(key));
        if (info.mtimeMs >= cutoff) continue;
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      await this.delete(key);
      removed++;
    }
    return removed;
  }

  async delete(key: string) {
    validateBlobKey(key);
    try {
      const root = await this.root;
      await unlink(await this.path(key));
      this.removeKey(key);
      await syncDirectory(root);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
export function create({
  config,
  bindings,
}: CreateContext<BlobConfig, { logger?: Pick<Logger, "warn"> }>): FsBlobStore {
  return new FsBlobStore(config, bindings.logger);
}
