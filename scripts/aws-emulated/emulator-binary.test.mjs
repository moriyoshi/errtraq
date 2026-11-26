import { afterEach, describe, expect, it } from "vitest";
import {
  assets,
  commit,
  defaultBinary,
  hostTriple,
  prebuiltBinary,
  sourceSha256,
  tag,
} from "./emulator-binary.mjs";

describe("pinned emulator release", () => {
  const saved = process.env.ERRTRAQ_WINTERBAUME_BINARY;
  afterEach(() => {
    if (saved === undefined) delete process.env.ERRTRAQ_WINTERBAUME_BINARY;
    else process.env.ERRTRAQ_WINTERBAUME_BINARY = saved;
  });
  it("pins a tag, a commit and well-formed checksums", () => {
    expect(tag).toBe("winterbaume-server-v0.2.10");
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const asset of Object.values(assets))
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("lets ERRTRAQ_WINTERBAUME_BINARY override the install location", () => {
    process.env.ERRTRAQ_WINTERBAUME_BINARY = "/custom/winterbaume-server";
    expect(defaultBinary()).toBe("/custom/winterbaume-server");
  });
  it("locates the prebuilt binary under the versioned install directory", () => {
    expect(prebuiltBinary("aarch64-apple-darwin")).toMatch(
      /winterbaume-server-v0\.2\.10\/bin\/winterbaume-server-aarch64-apple-darwin\/winterbaume-server$/,
    );
    expect(["string", "undefined"]).toContain(typeof hostTriple());
  });
});
