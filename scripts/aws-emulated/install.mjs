import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assets,
  base,
  builtBinary,
  hostTriple,
  prebuiltBinary,
  releaseBase,
  sourceSha256,
  tag,
} from "./emulator-binary.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dl = join(base, "dl");

// Reads a cached download (verified) or fetches and caches it (verified).
async function obtain(name, expected) {
  const path = join(dl, name);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    const response = await fetch(`${releaseBase}/${name}`);
    if (!response.ok)
      throw new Error(`Winterbaume download returned HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha(bytes) !== expected)
      throw new Error(`Winterbaume ${name} checksum mismatch`);
    await mkdir(dl, { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  }
  if (sha(bytes) !== expected)
    throw new Error(`Winterbaume ${name} checksum mismatch`);
  return path;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.status}`,
    );
}

const triple = hostTriple();
const asset = triple ? assets[triple] : undefined;
if (asset) {
  try {
    await access(prebuiltBinary(triple));
    console.log(`Pinned Winterbaume ${tag} already installed.`);
    process.exit(0);
  } catch {}
  const archive = await obtain(
    `winterbaume-server-${triple}.tar.xz`,
    asset.sha256,
  );
  const out = join(base, "bin");
  await mkdir(out, { recursive: true });
  run("tar", ["-xJf", archive, "-C", out]);
  await access(prebuiltBinary(triple));
  console.log(`Installed prebuilt ${tag} for ${triple}.`);
} else {
  try {
    await access(builtBinary);
    console.log(`Pinned Winterbaume ${tag} build already installed.`);
    process.exit(0);
  } catch {}
  const archive = await obtain("source.tar.gz", sourceSha256);
  const source = join(base, "source");
  await mkdir(source, { recursive: true });
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
  run(
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
  );
  console.log(`Built pinned Winterbaume ${tag} from source.`);
}
