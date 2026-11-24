import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ModuleRef {
  provider: string;
  component: string;
}
/** The installed `@errtraq/terraform-modules` package: its directory holds `<provider>/<component>`. */
export async function terraformModulesPackage(): Promise<{
  directory: string;
  version: string;
}> {
  let manifest: string;
  try {
    manifest = createRequire(import.meta.url).resolve(
      "@errtraq/terraform-modules/package.json",
    );
  } catch {
    throw new Error("Cannot find @errtraq/terraform-modules");
  }
  const { version } = JSON.parse(await readFile(manifest, "utf8")) as {
    version: string;
  };
  return { directory: dirname(await realpath(manifest)), version };
}
const childSource = /^\s*source\s*=\s*"(\.{1,2}\/[^"]*)"/gm;
function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}
function skipped(name: string): boolean {
  return (
    name === "tests" ||
    name.endsWith(".tftest.hcl") ||
    name.startsWith(".terraform") ||
    name.startsWith("terraform.tfstate")
  );
}
/** Module directories (relative to `root`, sorted) needed by `modules`, following relative child `source`s. */
export async function moduleClosure(
  root: string,
  modules: readonly ModuleRef[],
): Promise<string[]> {
  const found = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    const key = relative(root, directory).split(sep).join("/");
    if (found.has(key)) return;
    if (
      !(await lstat(directory).catch(() => undefined))?.isDirectory() ||
      (await realpath(directory)) !== directory
    )
      throw new Error(`Terraform module not found: ${key}`);
    found.add(key);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".tf")) continue;
      const text = await readFile(join(directory, entry.name), "utf8");
      for (const match of text.matchAll(childSource)) {
        const child = resolve(directory, match[1] ?? "");
        if (!inside(root, child))
          throw new Error(
            `Terraform module ${key} references a path outside the modules directory`,
          );
        await visit(child);
      }
    }
  };
  for (const { provider, component } of modules)
    await visit(join(root, provider, component));
  return [...found].sort();
}
async function copyModule(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of (await readdir(from, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )) {
    if (skipped(entry.name)) continue;
    if (entry.isDirectory())
      await copyModule(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile())
      await writeFile(
        join(to, entry.name),
        await readFile(join(from, entry.name)),
      );
    else
      throw new Error(`Unsupported entry in Terraform module: ${entry.name}`);
  }
}
/** Copy the modules a stack uses, plus their child modules, into `target` and stamp `VERSION`. */
export async function vendorModules(
  root: string,
  target: string,
  modules: readonly ModuleRef[],
  version: string,
): Promise<string[]> {
  const closure = await moduleClosure(root, modules);
  for (const directory of closure)
    await copyModule(join(root, directory), join(target, directory));
  await writeFile(join(target, "VERSION"), `${version}\n`);
  return closure;
}
