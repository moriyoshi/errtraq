import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(
  new URL("../../.agents-workspace/tmp/", import.meta.url),
);
const revision = "69fed1d7fb0eb9a2738ff3274197c7591129c4cb";
const archiveHash =
  "6e48ddc5b3654d7557248b397f8afffb4114b83c2f76c26289ffeaa995d145d9";
const patchHash =
  "3c64004d70de6f0e78fcc544d7f46fd06715c0050f880dd4d60f99f6598296d9";
const base = join(root, `winterbaume-${revision}-s3-utf8`);
const binary = join(base, "target/debug/winterbaume-server");
try {
  await access(binary);
  console.log("Patched S3 contract emulator already installed.");
  process.exit(0);
} catch {}
const patch = fileURLToPath(
  new URL("./winterbaume-s3-utf8.patch", import.meta.url),
);
if (
  createHash("sha256")
    .update(await readFile(patch))
    .digest("hex") !== patchHash
)
  throw new Error("S3 emulator patch checksum mismatch");
try {
  await mkdir(base);
} catch {
  throw new Error(
    "Patched emulator directory already exists without a build; inspect it before retrying",
  );
}
const archive = join(base, "source.tar.gz"),
  source = join(base, "source");
const response = await fetch(
  `https://github.com/moriyoshi/winterbaume/archive/${revision}.tar.gz`,
);
if (!response.ok)
  throw new Error(`Winterbaume download returned HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== archiveHash)
  throw new Error("Winterbaume source checksum mismatch");
await writeFile(archive, bytes, { flag: "wx" });
await mkdir(source);
for (const [command, args, options] of [
  ["tar", ["-xzf", archive, "--strip-components=1", "-C", source], {}],
  ["patch", ["--batch", "-p1", "-i", patch], { cwd: source }],
  [
    "cargo",
    ["build", "--locked", "-p", "winterbaume-server", "--no-default-features"],
    {
      cwd: source,
      env: {
        ...process.env,
        CARGO_HOME: join(base, "cargo"),
        CARGO_TARGET_DIR: join(base, "target"),
      },
    },
  ],
]) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.status}`,
    );
}
console.log(
  `Installed Winterbaume ${revision} with the verified S3 UTF-8 patch.`,
);
