import type { Logger } from "@errtraq/core";
import { IngestError, type IngestService, parseDsnKey } from "@errtraq/core";
import { Hono } from "hono";
import { logUnexpected } from "./errors.js";

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
function bodyStream(
  request: Request,
  limit: number,
): ReadableStream<Uint8Array> | null {
  const encoding = (request.headers.get("content-encoding") ?? "identity")
    .trim()
    .toLowerCase();
  if (!["identity", "gzip", "deflate", "br"].includes(encoding))
    throw new IngestError(415, "Unsupported content encoding");
  const original = request.body;
  if (!original) return null;
  let compressedSize = 0;
  const source = original.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        compressedSize += chunk.byteLength;
        if (compressedSize > limit)
          throw new IngestError(413, "Envelope too large");
        controller.enqueue(chunk);
      },
    }),
  );
  if (encoding === "identity") return source;
  try {
    const compressed = source.pipeThrough(
      new TransformStream<Uint8Array, BufferSource>({
        transform(chunk, controller) {
          controller.enqueue(new Uint8Array(chunk));
        },
      }),
    );
    return compressed.pipeThrough(
      new DecompressionStream(encoding as CompressionFormat),
    );
  } catch {
    throw new IngestError(415, "Unsupported content encoding");
  }
}
async function headerAndBody(
  stream: ReadableStream<Uint8Array> | null,
  service: IngestService,
  projectId: string,
): Promise<Uint8Array> {
  if (!stream) throw new IngestError(401, "Missing Sentry key");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let newline = -1;
  try {
    while (newline < 0) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.length;
      newline = next.value.indexOf(10);
      if (size > service.maxBytes)
        throw new IngestError(413, "Envelope too large");
    }
    if (newline < 0) throw new IngestError(401, "Missing Sentry key");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const end = bytes.indexOf(10);
    let key: string | null = null;
    try {
      const header = JSON.parse(
        new TextDecoder().decode(bytes.subarray(0, end)),
      ) as { dsn?: unknown };
      if (typeof header.dsn === "string")
        key = decodeURIComponent(new URL(header.dsn).username) || null;
    } catch {
      /* invalid or missing DSN */
    }
    await service.authenticate(projectId, key);
    const tail = await readBounded(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() {
          return reader.cancel();
        },
      }),
      service.maxBytes - size,
    );
    const result = new Uint8Array(size + tail.length);
    result.set(bytes);
    result.set(tail, size);
    return result;
  } finally {
    reader.releaseLock();
  }
}
/** Hono ingest app accepting Sentry envelope and legacy store endpoints. */
export function createIngestApp(
  service: IngestService,
  logger?: Pick<Logger, "error">,
): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    const requestId = logUnexpected(logger, error, c.req.raw);
    return c.json({ detail: "Internal server error", requestId }, 500);
  });
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
      let key = parseDsnKey(
        c.req.header("X-Sentry-Auth"),
        c.req.query("sentry_key"),
      );
      const projectId = c.req.param("projectId") ?? "";
      const length = Number(c.req.header("Content-Length"));
      if (Number.isFinite(length) && length > service.maxBytes)
        throw new IngestError(413, "Envelope too large");
      if (key || legacy) await service.authenticate(projectId, key);
      const stream = bodyStream(c.req.raw, service.maxBytes);
      let body: Uint8Array;
      try {
        if (key) body = await readBounded(stream, service.maxBytes);
        else {
          body = await headerAndBody(stream, service, projectId);
          const header = JSON.parse(
            new TextDecoder().decode(body.subarray(0, body.indexOf(10))),
          ) as { dsn: string };
          key = decodeURIComponent(new URL(header.dsn).username);
        }
      } catch (error) {
        if (error instanceof IngestError) throw error;
        throw new IngestError(400, "Invalid compressed body");
      }
      const result = await service.accept({
        projectId,
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
        if (failure.status === 429)
          c.header("X-Sentry-Rate-Limits", `${failure.retryAfter}::project`);
      }
      const requestId =
        failure.status === 500
          ? logUnexpected(logger, error, c.req.raw)
          : undefined;
      return c.json(
        { detail: failure.message, ...(requestId ? { requestId } : {}) },
        failure.status as 400 | 401 | 403 | 413 | 415 | 429 | 500 | 503,
      );
    }
  };
  app.post("/api/:projectId/envelope/", handler(false));
  app.post("/api/:projectId/envelope", handler(false));
  app.post("/api/:projectId/store/", handler(true));
  app.post("/api/:projectId/store", handler(true));
  return app;
}
