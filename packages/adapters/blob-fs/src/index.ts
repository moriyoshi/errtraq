import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore, Cursor } from "@errtraq/core";
import { type BlobConfig, configSchema } from "./stack.js";

export { infra, manifest } from "./stack.js";

interface Header {
  key: string;
  contentType?: string;
}
const hashKey = (key: string) =>
  `object-${createHash("sha256").update(key, "utf16le").digest("hex")}`;
const noFollow = constants.O_RDONLY | constants.O_NOFOLLOW;
async function readHeader(
  file: FileHandle,
): Promise<{ header: Header; offset: number }> {
  const lengthBytes = Buffer.alloc(4);
  if ((await file.read(lengthBytes, 0, 4, 0)).bytesRead !== 4)
    throw new Error("Invalid blob header");
  const length = lengthBytes.readUInt32BE();
  if (length > 1024 * 1024) throw new Error("Blob header too large");
  const payload = Buffer.alloc(length);
  if ((await file.read(payload, 0, length, 4)).bytesRead !== length)
    throw new Error("Invalid blob header");
  return {
    header: JSON.parse(payload.toString("utf8")) as Header,
    offset: 4 + length,
  };
}
function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Keys are encoded as hashes in a flat directory; symlinks are never followed. */
export class FsBlobStore implements BlobStore {
  private root: Promise<string>;
  constructor(config: BlobConfig) {
    const { root } = configSchema.parse(config);
    this.root = (async () => {
      await mkdir(root, { recursive: true });
      return realpath(root);
    })();
  }
  private async path(key: string) {
    return join(await this.root, hashKey(key));
  }
  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    metadata?: { contentType?: string; size?: number },
  ): Promise<void> {
    const root = await this.root;
    const temp = join(root, `.tmp-${randomUUID()}`);
    const target = await this.path(key);
    const header: Header = {
      key,
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
      await file.close();
      await rename(temp, target);
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
      if (header.key !== key) throw new Error("Blob key mismatch");
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
    let file: FileHandle;
    try {
      file = await open(await this.path(key), noFollow);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      const { header, offset } = await readHeader(file);
      if (header.key !== key) throw new Error("Blob key mismatch");
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
  async list(prefix: string, cursor?: Cursor, limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("Invalid limit");
    const root = await this.root;
    const entries = await readdir(root, { withFileTypes: true });
    const keys: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^object-[a-f0-9]{64}$/.test(entry.name))
        continue;
      let file: FileHandle;
      try {
        file = await open(join(root, entry.name), noFollow);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      try {
        const { header } = await readHeader(file);
        if (hashKey(header.key) !== entry.name)
          throw new Error("Blob key mismatch");
        if (header.key.startsWith(prefix)) keys.push(header.key);
      } finally {
        await file.close();
      }
    }
    keys.sort();
    const after = cursor !== undefined ? String(cursor) : undefined;
    const rows = after === undefined ? keys : keys.filter((key) => key > after);
    const items = rows.slice(0, limit);
    return {
      items,
      nextCursor:
        rows.length > limit ? (items[items.length - 1] as Cursor) : null,
    };
  }
  async delete(key: string) {
    try {
      await unlink(await this.path(key));
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}
export function create(
  config: BlobConfig,
  _bindings: Record<string, unknown> = {},
): FsBlobStore {
  return new FsBlobStore(config);
}
