import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(
  new URL("../../.agents-workspace/tmp/", import.meta.url),
);
const revision = "79c452d2bb2844abf771cfa4a497275c24b46489";
const sha256 =
  "1ae53165343300f21e83ba63f611d8ce51f0afd3bb52816604329da3f32e94a0";
const base = join(root, `winterbaume-${revision}`);
const binary = join(base, "target/debug/winterbaume-server");
try {
  await access(binary);
  console.log("Pinned Winterbaume build already installed.");
  process.exit(0);
} catch {}
await mkdir(base, { recursive: true });
const archive = join(base, "source.tar.gz");
let bytes;
try {
  bytes = await readFile(archive);
} catch {
  const response = await fetch(
    `https://github.com/moriyoshi/winterbaume/archive/${revision}.tar.gz`,
  );
  if (!response.ok)
    throw new Error(`Winterbaume download returned HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error("Winterbaume source checksum mismatch");
  await writeFile(archive, bytes, { flag: "wx" });
}
if (createHash("sha256").update(bytes).digest("hex") !== sha256)
  throw new Error("Winterbaume source checksum mismatch");
const source = join(base, "source");
await mkdir(source, { recursive: true });
for (const [command, args, options] of [
  ["tar", ["-xzf", archive, "--strip-components=1", "-C", source], {}],
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
console.log(`Installed pinned Winterbaume ${revision}.`);
