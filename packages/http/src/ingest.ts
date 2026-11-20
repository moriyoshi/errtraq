import { IngestError, type IngestService, parseDsnKey } from "@errtraq/core";
import { Hono } from "hono";

async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new IngestError(413, "Envelope too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
}
async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const encoding = (request.headers.get("content-encoding") ?? "identity")
    .trim()
    .toLowerCase();
  if (!["identity", "gzip", "deflate", "br"].includes(encoding))
    throw new IngestError(415, "Unsupported content encoding");
  const compressed = await readBounded(request.body, limit);
  if (encoding === "identity") return compressed;
  let decompressor: DecompressionStream;
  try {
    decompressor = new DecompressionStream(encoding as CompressionFormat);
  } catch {
    throw new IngestError(415, "Unsupported content encoding");
  }
  const input = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(compressed));
      controller.close();
    },
  });
  try {
    return await readBounded(input.pipeThrough(decompressor), limit);
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(400, "Invalid compressed body");
  }
}
/** Hono ingest app accepting Sentry envelope and legacy store endpoints. */
export function createIngestApp(service: IngestService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Content-Encoding, X-Sentry-Auth, X-Requested-With, sentry-trace, baggage",
    );
    c.header(
      "Access-Control-Expose-Headers",
      "X-Sentry-Error, X-Sentry-Rate-Limits, Retry-After",
    );
  });
  app.options("*", (c) => c.body(null, 204));
  const handler = (legacy: boolean) => async (c: import("hono").Context) => {
    try {
      const body = await readBody(c.req.raw, service.maxBytes);
      const key = parseDsnKey(
        c.req.header("X-Sentry-Auth"),
        c.req.query("sentry_key"),
      );
      const result = await service.accept({
        projectId: c.req.param("projectId") ?? "",
        key,
        body,
        legacy,
      });
      return c.json(result, 200);
    } catch (error) {
      const failure =
        error instanceof IngestError
          ? error
          : new IngestError(500, "Internal server error");
      c.header("X-Sentry-Error", failure.message);
      if (failure.retryAfter !== undefined) {
        c.header("Retry-After", String(failure.retryAfter));
        c.header("X-Sentry-Rate-Limits", `${failure.retryAfter}:error:project`);
      }
      return c.json(
        { detail: failure.message },
        failure.status as 400 | 401 | 403 | 413 | 415 | 429 | 500,
      );
    }
  };
  app.post("/api/:projectId/envelope/", handler(false));
  app.post("/api/:projectId/store/", handler(true));
  return app;
}
