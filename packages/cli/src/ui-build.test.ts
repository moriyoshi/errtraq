import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildUiAssets,
  UI_IMMUTABLE_CACHE,
  uiCacheControl,
  uiContentType,
  verifyUiAssets,
} from "./ui-build.js";

let temp: string;
beforeAll(async () => {
  await mkdir(resolve(".agents-workspace/tmp"), { recursive: true });
  temp = await mkdtemp(resolve(".agents-workspace/tmp/ui-build-test-"));
});
afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});
async function site(name: string): Promise<string> {
  const dir = join(temp, name);
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html>");
  await writeFile(join(dir, "assets", "index-abc123.js"), "export {};");
  await writeFile(join(dir, "assets", "index-abc123.css"), "body{}");
  await writeFile(join(dir, "favicon.svg"), "<svg/>");
  return dir;
}

describe("UI build manifest", () => {
  it("assigns content types and the cache rules by path", () => {
    expect(uiContentType("index.html")).toBe("text/html; charset=utf-8");
    expect(uiContentType("assets/a.js")).toBe("text/javascript; charset=utf-8");
    expect(uiContentType("assets/a.woff2")).toBe("font/woff2");
    expect(uiContentType("blob.unknown")).toBe("application/octet-stream");
    expect(uiCacheControl("assets/index-abc.js")).toBe(UI_IMMUTABLE_CACHE);
    expect(UI_IMMUTABLE_CACHE).toBe("public, max-age=31536000, immutable");
    expect(uiCacheControl("index.html")).toBe("no-cache");
    expect(uiCacheControl("favicon.svg")).toBe("no-cache");
  });
  it("copies the files, hashes them and lists them in a sorted manifest", async () => {
    const source = await site("ok");
    const output = join(temp, "out-ok");
    await mkdir(output);
    const manifest = await buildUiAssets(source, output);
    expect(manifest.assets.map((asset) => asset.path)).toEqual([
      "assets/index-abc123.css",
      "assets/index-abc123.js",
      "favicon.svg",
      "index.html",
    ]);
    const index = manifest.assets.find((asset) => asset.path === "index.html");
    expect(index).toEqual({
      path: "index.html",
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
      contentHash: createHash("sha256")
        .update("<!doctype html>")
        .digest("base64"),
      size: 15,
    });
    expect(
      await readFile(join(output, "ui/site/assets/index-abc123.js"), "utf8"),
    ).toBe("export {};");
    expect(
      JSON.parse(await readFile(join(output, "ui/manifest.json"), "utf8")),
    ).toEqual(manifest);
    expect(await verifyUiAssets(output)).toEqual(manifest);
    // A rebuild replaces the copy rather than merging with a removed file.
    await rm(join(source, "favicon.svg"));
    const again = await buildUiAssets(source, output);
    expect(again.assets).toHaveLength(3);
    await expect(
      readFile(join(output, "ui/site/favicon.svg")),
    ).rejects.toThrow();
  });
  it("detects a changed, missing or unsafe asset before Terraform is generated", async () => {
    const source = await site("verify");
    const output = join(temp, "out-verify");
    await mkdir(output);
    await buildUiAssets(source, output);
    await writeFile(join(output, "ui/site/index.html"), "<!doctype html>!");
    await expect(verifyUiAssets(output)).rejects.toThrow(
      "UI asset hash mismatch: index.html",
    );
    await rm(join(output, "ui/site/index.html"));
    await expect(verifyUiAssets(output)).rejects.toThrow(
      "UI asset missing: index.html",
    );
    await expect(verifyUiAssets(join(temp, "nowhere"))).rejects.toThrow(
      "UI build manifest not found",
    );
    for (const path of ["../x", "/x", "a//b", "a\\b", ".hidden"]) {
      await mkdir(join(temp, "bad"), { recursive: true });
      await mkdir(join(temp, "bad/ui"), { recursive: true });
      await rm(join(temp, "bad/ui/manifest.json"), { force: true });
      await writeFile(
        join(temp, "bad/ui/manifest.json"),
        JSON.stringify({
          version: 1,
          assets: [
            { path: "index.html", contentHash: "", size: 0 },
            { path, contentHash: "", size: 0 },
          ],
        }),
      );
      await expect(verifyUiAssets(join(temp, "bad")), path).rejects.toThrow(
        /Invalid UI asset path|UI asset missing/,
      );
    }
  });
  it("refuses a missing directory, no index.html, symbolic links and odd names", async () => {
    const output = join(temp, "out-refuse");
    await mkdir(output);
    await expect(buildUiAssets(join(temp, "nowhere"), output)).rejects.toThrow(
      "does not exist",
    );
    const empty = join(temp, "empty");
    await mkdir(empty);
    await expect(buildUiAssets(empty, output)).rejects.toThrow("no index.html");
    const linked = await site("linked");
    await symlink(join(temp, "ok"), join(linked, "escape"));
    await expect(buildUiAssets(linked, output)).rejects.toThrow(
      "symbolic link",
    );
    const odd = await site("odd");
    await writeFile(join(odd, "has space.txt"), "x");
    await expect(buildUiAssets(odd, output)).rejects.toThrow("not portable");
    const hidden = await site("hidden");
    await writeFile(join(hidden, ".env"), "x");
    await expect(buildUiAssets(hidden, output)).rejects.toThrow("not portable");
  });
});
