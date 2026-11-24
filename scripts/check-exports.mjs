import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkExports(manifest, directory, paths) {
  const errors = [];
  for (const [entry, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target === "string") continue;
    const specifier = manifest.name + (entry === "." ? "" : entry.slice(1));
    if (
      !target ||
      typeof target !== "object" ||
      typeof target.development !== "string" ||
      !target.development.startsWith("./src/")
    ) {
      errors.push(`${specifier}: missing development source export`);
      continue;
    }
    const expected = `${directory}/${target.development.slice(2)}`;
    if (!paths[specifier]?.includes(expected))
      errors.push(`${specifier}: missing typecheck path to ${expected}`);
  }
  return errors;
}
function withoutDevelopment(target) {
  if (!target || typeof target !== "object") return target;
  const { development: _, ...rest } = target;
  return rest;
}
/** Public packages publish the same exports minus the `development` condition. */
export function checkPublishConfig(manifest) {
  if (manifest.private) return [];
  const expected = Object.fromEntries(
    Object.entries(manifest.exports ?? {}).map(([entry, target]) => [
      entry,
      withoutDevelopment(target),
    ]),
  );
  const actual = manifest.publishConfig?.exports;
  if (!actual) return [`${manifest.name}: missing publishConfig.exports`];
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? []
    : [
        `${manifest.name}: publishConfig.exports must equal exports without the development condition`,
      ];
}
async function run() {
  const configs = JSON.parse(await readFile("tsconfig.tests.json", "utf8"));
  const paths = configs.compilerOptions.paths;
  const dirs = [];
  for (const entry of await readdir("packages", { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (["adapters", "platforms"].includes(entry.name)) {
      for (const sub of await readdir(join("packages", entry.name), {
        withFileTypes: true,
      }))
        if (sub.isDirectory())
          dirs.push(join("packages", entry.name, sub.name));
    } else dirs.push(join("packages", entry.name));
  }
  const errors = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(
      await readFile(join(dir, "package.json"), "utf8"),
    );
    errors.push(...checkExports(manifest, dir, paths));
    errors.push(...checkPublishConfig(manifest));
    for (const target of Object.values(manifest.exports ?? {}))
      if (
        target &&
        typeof target === "object" &&
        typeof target.development === "string"
      ) {
        try {
          await access(join(dir, target.development));
        } catch {
          errors.push(`${dir}: source export does not exist`);
        }
      }
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await run();
