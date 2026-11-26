import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { extname, join, posix } from "node:path";

/** One file of the built web UI, as Terraform uploads it (an `aws_s3_object`). */
export interface UiAsset {
  /** POSIX path relative to the site root, no leading slash. */
  path: string;
  contentType: string;
  cacheControl: string;
  /** Base64 SHA-256 of the file bytes, like the Lambda artifacts' `contentHash`. */
  contentHash: string;
  size: number;
}
/** `ui/manifest.json` in the build output: what Terraform reads, with the files under `ui/site/`. */
export interface UiManifest {
  version: 1;
  assets: UiAsset[];
}
/** Directory of the UI inside a build output, and the file tree and manifest inside it. */
export const UI_BUILD_DIRECTORY = "ui";
export const UI_SITE_DIRECTORY = "site";
export const UI_MANIFEST_FILE = "manifest.json";
/** Hashed build output (`assets/*`) never changes under one name; everything else is revalidated. */
export const UI_IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
export const UI_REVALIDATE_CACHE = "no-cache";
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
const MAX_ASSETS = 2000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~@+=,-]*$/;

export function uiContentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
export function uiCacheControl(path: string): string {
  return path.startsWith("assets/") ? UI_IMMUTABLE_CACHE : UI_REVALIDATE_CACHE;
}
async function collect(root: string, prefix: string[]): Promise<string[]> {
  const found: string[] = [];
  const directory = join(root, ...prefix);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )) {
    const parts = [...prefix, entry.name];
    if (!SAFE_SEGMENT.test(entry.name))
      throw new Error(`UI file name is not portable: ${parts.join("/")}`);
    if (entry.isSymbolicLink())
      throw new Error(
        `UI directory contains a symbolic link: ${parts.join("/")}`,
      );
    if (entry.isDirectory()) found.push(...(await collect(root, parts)));
    else if (entry.isFile()) found.push(parts.join("/"));
    else
      throw new Error(
        `UI directory contains a special file: ${parts.join("/")}`,
      );
  }
  return found;
}
/**
 * Copy a built UI (`packages/ui/dist`) into `<output>/ui/site` and write `<output>/ui/manifest.json`.
 * The copy is the build input: Terraform and the standalone container read it, never the source
 * directory. Symbolic links, special files and non-portable names are refused.
 */
export async function buildUiAssets(
  source: string,
  output: string,
): Promise<UiManifest> {
  const root = await realpath(source).catch(() => undefined);
  if (!root || !(await lstat(root)).isDirectory())
    throw new Error(`UI directory ${source} does not exist; build it first`);
  if (!(await lstat(join(root, "index.html")).catch(() => undefined))?.isFile())
    throw new Error(`UI directory ${source} has no index.html; build it first`);
  const files = await collect(root, []);
  if (files.length > MAX_ASSETS)
    throw new Error(`UI directory has more than ${MAX_ASSETS} files`);
  const target = join(output, UI_BUILD_DIRECTORY);
  await rm(target, { recursive: true, force: true });
  const assets: UiAsset[] = [];
  for (const path of files) {
    const bytes = await readFile(join(root, ...path.split("/")));
    const destination = join(target, UI_SITE_DIRECTORY, ...path.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, bytes);
    assets.push({
      path,
      contentType: uiContentType(path),
      cacheControl: uiCacheControl(path),
      contentHash: createHash("sha256").update(bytes).digest("base64"),
      size: bytes.byteLength,
    });
  }
  const manifest: UiManifest = { version: 1, assets };
  await writeFile(
    join(target, UI_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
/** Re-check a built UI before Terraform is generated: every file is present and matches its hash. */
export async function verifyUiAssets(
  buildDirectory: string,
): Promise<UiManifest> {
  const base = join(buildDirectory, UI_BUILD_DIRECTORY);
  let manifest: UiManifest;
  try {
    manifest = JSON.parse(await readFile(join(base, UI_MANIFEST_FILE), "utf8"));
  } catch {
    throw new Error(
      "UI build manifest not found: run errtraq build --stack <file> first",
    );
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.assets))
    throw new Error("Invalid UI build manifest");
  if (!manifest.assets.some((asset) => asset.path === "index.html"))
    throw new Error("UI build manifest has no index.html");
  for (const asset of manifest.assets) {
    if (
      typeof asset.path !== "string" ||
      posix.normalize(asset.path) !== asset.path ||
      asset.path.startsWith("/") ||
      asset.path.startsWith("../") ||
      asset.path.includes("\\") ||
      asset.path.split("/").some((part) => !SAFE_SEGMENT.test(part))
    )
      throw new Error(`Invalid UI asset path: ${String(asset.path)}`);
    const file = join(base, UI_SITE_DIRECTORY, ...asset.path.split("/"));
    let bytes: Buffer;
    try {
      const stat = await lstat(file);
      if (!stat.isFile())
        throw new Error(`UI asset ${asset.path} is not a regular file`);
      bytes = await readFile(file);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("UI asset"))
        throw error;
      throw new Error(
        `UI asset missing: ${asset.path}; run errtraq build first`,
      );
    }
    if (
      createHash("sha256").update(bytes).digest("base64") !== asset.contentHash
    )
      throw new Error(`UI asset hash mismatch: ${asset.path}`);
  }
  return manifest;
}
