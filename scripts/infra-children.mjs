import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const childSource = /^\s*source\s*=\s*"\.\.\/([A-Za-z0-9_-]+)"/gm;
/** Sibling modules (`source = "../<name>"`) that a module in `providerRoot` calls, transitively. */
export function childModules(providerRoot, component) {
  const found = new Set();
  const visit = (name) => {
    for (const entry of readdirSync(resolve(providerRoot, name))) {
      if (!entry.endsWith(".tf")) continue;
      const text = readFileSync(resolve(providerRoot, name, entry), "utf8");
      for (const match of text.matchAll(childSource)) {
        if (found.has(match[1])) continue;
        found.add(match[1]);
        visit(match[1]);
      }
    }
  };
  visit(component);
  return [...found].sort();
}
/**
 * Copy the sibling modules `component` calls next to its own copy (`<parent>/<child>`), pinning
 * each one's provider constraint like the module under test, so a relative `../child` source
 * resolves in a scratch directory.
 */
export function copyChildren(
  providerRoot,
  component,
  parent,
  constraint,
  version,
) {
  for (const child of childModules(providerRoot, component)) {
    const target = resolve(parent, child);
    cpSync(resolve(providerRoot, child), target, { recursive: true });
    const versions = resolve(target, "versions.tf");
    const source = readFileSync(versions, "utf8");
    const current = source.match(constraint)?.[0];
    if (!current)
      throw new Error(`Unexpected provider constraint in module ${child}`);
    writeFileSync(
      versions,
      source.replace(current, `version = "= ${version}"`),
    );
  }
}
