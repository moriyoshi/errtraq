import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import type { Context } from "hono";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
/** Hashed build output: the file name changes with the content, so it never needs revalidation. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** Sent with every HTML response; the page's own `<meta>` CSP cannot carry `frame-ancestors`. */
const HTML_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
} as const;

/** The response for a request, or `undefined` when the UI does not serve this path. */
export type UiHandler = (c: Context) => Promise<Response | undefined>;
/**
 * Serve a directory of built UI assets: real files as they are, and any other `GET` that is not
 * an API path and accepts `text/html` as `index.html` (single-page-app routes). `/api/**` never
 * falls back, so an unknown API route keeps its own 404. Paths never leave the directory: dot
 * segments, NUL, backslashes and symbolic links that resolve outside it are all refused.
 */
export async function createUiHandler(directory: string): Promise<UiHandler> {
  const root = await realpath(directory).catch(() => undefined);
  if (!root || !(await stat(root)).isDirectory())
    throw new Error(`UI directory ${directory} is not a directory`);
  if (!(await stat(join(root, "index.html")).catch(() => undefined))?.isFile())
    throw new Error(`UI directory ${directory} has no index.html`);
  /** The file at a request path inside the root, or `undefined`. */
  async function lookup(segments: string[]): Promise<string | undefined> {
    const real = await realpath(join(root as string, ...segments)).catch(
      () => undefined,
    );
    if (!real?.startsWith(`${root}${sep}`)) return undefined;
    return (await stat(real).catch(() => undefined))?.isFile()
      ? real
      : undefined;
  }
  async function respond(
    c: Context,
    file: string,
    cacheControl: string,
  ): Promise<Response> {
    const type =
      TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const html = type.startsWith("text/html");
    const body = await readFile(file);
    return new Response(c.req.method === "HEAD" ? null : body, {
      headers: {
        "Content-Type": type,
        "Content-Length": String(body.byteLength),
        "Cache-Control": cacheControl,
        "X-Content-Type-Options": "nosniff",
        ...(html ? HTML_HEADERS : {}),
      },
    });
  }
  const index = (c: Context) =>
    respond(c, join(root, "index.html"), "no-cache");
  return async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return undefined;
    const raw = new URL(c.req.url).pathname;
    if (raw === "/api" || raw.startsWith("/api/")) return undefined;
    let path: string;
    try {
      path = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    if (path.includes("\0") || path.includes("\\")) return undefined;
    const segments = path.split("/").filter((segment) => segment !== "");
    if (segments.some((segment) => segment.startsWith("."))) return undefined;
    if (segments.length === 0) return index(c);
    const file = await lookup(segments);
    if (file) {
      if (segments.length === 1 && segments[0] === "index.html")
        return index(c);
      return respond(
        c,
        file,
        segments[0] === "assets" ? IMMUTABLE : "no-cache",
      );
    }
    // A missing file is an SPA route only for a navigation, never for a script or stylesheet.
    if ((c.req.header("accept") ?? "").toLowerCase().includes("text/html"))
      return index(c);
    return undefined;
  };
}
