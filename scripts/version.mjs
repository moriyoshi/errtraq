import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function packageFiles(root) {
  const files = [];
  for (const entry of await readdir(join(root, "packages"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    if (["adapters", "platforms"].includes(entry.name)) {
      for (const sub of await readdir(join(root, "packages", entry.name), {
        withFileTypes: true,
      }))
        if (sub.isDirectory())
          files.push(
            join(root, "packages", entry.name, sub.name, "package.json"),
          );
    } else files.push(join(root, "packages", entry.name, "package.json"));
  }
  return files.sort();
}
/** Set every public package to `version`; refuse to run when their current versions differ. */
export async function setVersion(root, version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error(`Not a semantic version: ${version}`);
  const manifests = [];
  for (const file of await packageFiles(root)) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    if (!manifest.private) manifests.push({ file, manifest });
  }
  const versions = new Set(manifests.map(({ manifest }) => manifest.version));
  if (versions.size > 1)
    throw new Error(
      `Public packages have different versions: ${[...versions].join(", ")}`,
    );
  for (const { file, manifest } of manifests) {
    manifest.version = version;
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return manifests.map(({ manifest }) => manifest.name);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const version = process.argv[2];
  if (!version) {
    console.error("Usage: node scripts/version.mjs <version>");
    process.exitCode = 1;
  } else
    try {
      const names = await setVersion(process.cwd(), version);
      console.log(`Set ${names.length} packages to ${version}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
