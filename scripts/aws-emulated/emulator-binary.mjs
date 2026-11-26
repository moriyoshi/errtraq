import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Pinned Winterbaume server release (tag winterbaume-server-v0.2.10).
export const version = "0.2.10";
export const tag = `winterbaume-server-v${version}`;
export const commit = "f79b3353ec2e49259267572719a15b4a29955435";
export const sourceSha256 =
  "ff42c567f7ca65c748730234a115f1532ebe98693e4af2b7adfc0fc28f069c5d";
// SHA-256 of the prebuilt release assets, keyed by target triple. Hosts without
// an entry build source.tar.gz instead. Add a triple only after verifying the
// asset against the release's published .sha256 file.
export const assets = {
  "aarch64-apple-darwin": {
    sha256: "3972eada905bd3cd6b1fc4af03bf4e35b85b5f6535fdbbac672bba467e100640",
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
