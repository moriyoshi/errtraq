import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Pinned Winterbaume server release (tag winterbaume-server-v0.2.9).
export const version = "0.2.9";
export const tag = `winterbaume-server-v${version}`;
export const commit = "70006139231c1d0569a6ec303a671e53b8d6e6c3";
export const sourceSha256 =
  "fcd7ce0b22645cdda48e15533d4699ad67124f3ba46e3804ed8d1cbecf938c13";
// SHA-256 of the prebuilt release assets, keyed by target triple. Hosts without
// an entry build source.tar.gz instead. Add a triple only after verifying the
// asset against the release's published .sha256 file.
export const assets = {
  "aarch64-apple-darwin": {
    sha256: "c7e80093e19af3a3694774fd22f7d25f007229f38d360bee7b279e5de1b7f8dc",
  },
};
export const releaseBase = `https://github.com/moriyoshi/winterbaume/releases/download/${tag}`;
export const base = resolve(
  ".agents-workspace/tmp",
  `winterbaume-server-v${version}`,
);

export function hostTriple() {
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  const os = {
    darwin: "apple-darwin",
    linux: "unknown-linux-gnu",
  }[process.platform];
  return arch && os ? `${arch}-${os}` : undefined;
}

export function prebuiltBinary(triple = hostTriple()) {
  return resolve(
    base,
    "bin",
    `winterbaume-server-${triple}`,
    "winterbaume-server",
  );
}
export const builtBinary = resolve(base, "target/debug/winterbaume-server");

// ERRTRAQ_WINTERBAUME_BINARY wins; otherwise the installed prebuilt or built binary.
export function defaultBinary() {
  if (process.env.ERRTRAQ_WINTERBAUME_BINARY)
    return process.env.ERRTRAQ_WINTERBAUME_BINARY;
  const prebuilt = prebuiltBinary();
  return existsSync(prebuilt) ? prebuilt : builtBinary;
}
