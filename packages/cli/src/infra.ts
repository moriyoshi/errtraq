import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  containsLocalPath,
  deriveDeployment,
  type ResolvedStack,
  selections,
} from "@errtraq/core";
import {
  generate,
  type ModuleSourceMode,
  validateModuleBase,
  vendorModuleDirectory,
} from "@errtraq/infra-gen";
import type { BuildManifest } from "./build.js";
import { terraformModulesPackage, vendorModules } from "./modules.js";

async function holds(directory: string, name: string): Promise<boolean> {
  try {
    await lstat(join(directory, name));
    return true;
  } catch {
    return false;
  }
}
async function nearest(
  start: string,
  name: string,
): Promise<string | undefined> {
  let current = start;
  while (true) {
    if (await holds(current, name)) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
/** `--root` if given, else the nearest ancestor of the stack file with a pnpm workspace file, then a package.json. */
export async function projectRoot(
  stackFile: string,
  options: { root?: string } = {},
): Promise<string> {
  if (options.root !== undefined) {
    const root = await realpath(resolve(options.root)).catch(() => undefined);
    if (!root || !(await lstat(root)).isDirectory())
      throw new Error("--root must be an existing directory");
    return root;
  }
  const start = dirname(await realpath(resolve(stackFile)));
  const root =
    (await nearest(start, "pnpm-workspace.yaml")) ??
    (await nearest(start, "package.json"));
  if (!root)
    throw new Error(
      "Cannot find the project root (no pnpm-workspace.yaml or package.json above the stack file); pass --root",
    );
  return root;
}
/** True when `root` is the errtraq development workspace (sources resolve through the `development` condition). */
export async function isErrtraqWorkspace(root: string): Promise<boolean> {
  try {
    await lstat(join(root, "pnpm-workspace.yaml"));
    const core = JSON.parse(
      await readFile(join(root, "packages/core/package.json"), "utf8"),
    ) as { name?: unknown };
    return core.name === "@errtraq/core";
  } catch {
    return false;
  }
}
function inside(repo: string, path: string): boolean {
  const r = relative(repo, path);
  return r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}
export async function safeDirectory(
  repo: string,
  requested: string,
): Promise<string> {
  const target = resolve(requested);
  if (!inside(repo, target) || target === repo)
    throw new Error("Output directory must be inside the repository");
  let current = target;
  while (true) {
    try {
      const actual = await realpath(current);
      if (!inside(repo, actual))
        throw new Error("Output directory resolves outside the repository");
      break;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
      current = dirname(current);
    }
  }
  await mkdir(target, { recursive: true });
  const actual = await realpath(target);
  if (!inside(repo, actual) || actual !== target)
    throw new Error("Output directory must not traverse symbolic links");
  return target;
}
const markerName = ".errtraq-generated.json";
const allowed = new Set([
  "main.tf.json",
  "variables.tf.json",
  "providers.tf.json",
  "outputs.tf.json",
  "terraform.tfvars.json",
  "backend.tf.json",
]);
/** Terraform owns these working files; generation never reads, modifies or deletes them. */
function terraformWorkingFile(name: string): boolean {
  return (
    name === ".terraform" ||
    name === ".terraform.lock.hcl" ||
    name.startsWith("terraform.tfstate") ||
    name.endsWith(".tfplan") ||
    /^crash(?:\..*)?\.log$/.test(name)
  );
}
/** Conservative direct-upload cutoff; AWS describes the 50 MB limit as approximate. */
export function validateLambdaArtifactSize(
  size: number,
  usesS3: boolean,
): void {
  if (!usesS3 && size > 50_000_000)
    throw new Error(
      "Lambda ZIP exceeds the direct upload limit; configure artifactBucket for S3 deployment",
    );
}
export interface InfraOptions {
  /** Defaults to `relative` when the modules directory is inside the project root and not in node_modules, else `vendor`. */
  moduleSource?: "relative" | "vendor" | "remote";
  /** Prefix for `remote`, e.g. `git::https://example.com/org/errtraq.git//infra/modules`. */
  moduleBase?: string;
  /** Overrides the modules directory (default: `infra/modules` in this workspace, else the installed package). */
  modulesDirectory?: string;
  /** Overrides the version stamped on vendored or remote modules (default: the terraform-modules package). */
  moduleVersion?: string;
}
async function resolveModules(
  stack: ResolvedStack,
  repo: string,
  options: InfraOptions,
): Promise<{
  directory: string;
  source: ModuleSourceMode;
  vendored?: { provider: string; component: string }[];
  version?: string;
}> {
  if (options.moduleBase !== undefined && options.moduleSource !== "remote")
    throw new Error("--module-base requires --module-source remote");
  if (options.moduleSource === "remote" && !options.moduleBase)
    throw new Error("--module-source remote requires --module-base");
  const directory =
    options.modulesDirectory ??
    ((await isErrtraqWorkspace(repo))
      ? resolve(repo, "infra/modules")
      : (await terraformModulesPackage()).directory);
  const mode =
    options.moduleSource ??
    (inside(repo, directory) && !directory.split(sep).includes("node_modules")
      ? "relative"
      : "vendor");
  if (mode === "relative") return { directory, source: { mode } };
  const version =
    options.moduleVersion ?? (await terraformModulesPackage()).version;
  if (mode === "remote")
    return {
      directory,
      source: {
        mode,
        base: validateModuleBase(options.moduleBase ?? ""),
        version,
      },
    };
  const vendored = [...selections(stack).values()].flatMap((selection) => {
    if (selection.existing) return [];
    const { provider, component } = selection.infra.module;
    return provider === "local" ? [] : [{ provider, component }];
  });
  return { directory, source: { mode }, vendored, version };
}
export async function generateInfra(
  stack: ResolvedStack,
  repo: string,
  output: string,
  buildDirectory: string,
  allowMissing: boolean,
  infraOptions: InfraOptions = {},
): Promise<string> {
  const view = deriveDeployment(stack);
  if (stack.platform.manifest.id === "standalone") {
    const result = generate(stack, {
      outputDirectory: resolve(output),
      modulesDirectory: resolve(repo, "infra/modules"),
      generationEnv: process.env,
      artifactPaths: {},
    });
    if (result.kind !== "not-applicable")
      throw new Error("Expected standalone to have no Terraform");
    return result.reason;
  }
  let manifest: BuildManifest | undefined;
  try {
    manifest = JSON.parse(
      await readFile(join(buildDirectory, "manifest.json"), "utf8"),
    ) as BuildManifest;
  } catch {
    if (!allowMissing)
      throw new Error(
        "Build manifest not found: run errtraq build --stack <file> first",
      );
  }
  if (
    manifest &&
    (manifest.stack !== stack.name ||
      manifest.platform !== stack.platform.manifest.id)
  )
    throw new Error("Build manifest does not match this stack");
  const artifacts: Record<string, string> = {};
  let placeholders = false;
  for (const fn of view.functions) {
    const artifact = manifest?.artifacts[fn.id];
    if (!artifact) {
      if (!allowMissing)
        throw new Error(
          `Missing build artifact for ${fn.id}; run errtraq build first`,
        );
      artifacts[fn.id] = `build/${fn.id}.zip`;
      placeholders = true;
      continue;
    }
    const full = resolve(repo, artifact.path);
    if (!inside(repo, full))
      throw new Error(`Invalid artifact path for ${fn.id}`);
    let bytes: Buffer;
    try {
      const actual = await realpath(full);
      if (!inside(repo, actual) || actual !== full)
        throw new Error(
          `Artifact path for ${fn.id} must not traverse symbolic links`,
        );
      bytes = await readFile(full);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
      if (!allowMissing)
        throw new Error(
          `Build artifact missing for ${fn.id}; run errtraq build first`,
        );
      artifacts[fn.id] = `build/${fn.id}.zip`;
      placeholders = true;
      continue;
    }
    if (
      createHash("sha256").update(bytes).digest("base64") !==
      artifact.contentHash
    )
      throw new Error(`Build artifact hash mismatch for ${fn.id}`);
    const config = stack.platform.config as {
      handler?: string;
      runtime?: string;
      artifactBucket?: unknown;
    };
    validateLambdaArtifactSize(
      bytes.byteLength,
      config.artifactBucket !== undefined,
    );
    if (
      artifact.handler !== (config.handler ?? "index.handler") ||
      artifact.runtime !== (config.runtime ?? "nodejs22.x")
    )
      throw new Error(
        `Build artifact handler or runtime mismatch for ${fn.id}`,
      );
    artifacts[fn.id] = relative(resolve(output), full).split(sep).join("/");
  }
  const modules = await resolveModules(stack, repo, infraOptions);
  const result = generate(stack, {
    outputDirectory: resolve(output),
    modulesDirectory: modules.directory,
    moduleSource: modules.source,
    generationEnv: process.env,
    artifactPaths: artifacts,
  });
  if (result.kind !== "terraform") return result.reason;
  if (
    Object.values(result.files).some((content) =>
      [repo, homedir()].some((path) => containsLocalPath(content, path)),
    )
  )
    throw new Error("Generated Terraform contains an absolute repository path");
  const target = await safeDirectory(repo, output);
  const entries = await readdir(target);
  let old: string[] = [];
  let hadModules = false;
  if (entries.length) {
    if (!entries.includes(markerName))
      throw new Error(
        "Output directory is not empty and has no generator marker",
      );
    if ((await lstat(join(target, markerName))).isSymbolicLink())
      throw new Error("Refusing symbolic link generator marker");
    let marker: unknown;
    try {
      marker = JSON.parse(await readFile(join(target, markerName), "utf8"));
    } catch {
      throw new Error("Invalid generator marker");
    }
    if (
      !marker ||
      typeof marker !== "object" ||
      !("generator" in marker) ||
      marker.generator !== "errtraq" ||
      !("stack" in marker) ||
      typeof marker.stack !== "string" ||
      !("files" in marker) ||
      !Array.isArray(marker.files) ||
      !marker.files.every(
        (f: unknown) => typeof f === "string" && allowed.has(f),
      ) ||
      ("modules" in marker &&
        marker.modules !== undefined &&
        typeof marker.modules !== "boolean")
    )
      throw new Error("Invalid generator marker");
    if (marker.stack !== stack.name)
      throw new Error(`Output directory belongs to stack ${marker.stack}`);
    old = marker.files;
    hadModules = "modules" in marker && marker.modules === true;
    if (
      entries.some(
        (entry) =>
          entry !== markerName &&
          !old.includes(entry) &&
          !(hadModules && entry === vendorModuleDirectory) &&
          !terraformWorkingFile(entry),
      )
    )
      throw new Error(
        "Output directory contains files not owned by the generator",
      );
  }
  for (const file of old)
    if (!(file in result.files)) await unlink(join(target, file));
  for (const [file, content] of Object.entries(result.files)) {
    if (!allowed.has(file))
      throw new Error(`Unexpected generator file ${file}`);
    const filePath = join(target, file);
    try {
      if ((await lstat(filePath)).isSymbolicLink())
        throw new Error(`Refusing symbolic link ${file}`);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    await writeFile(filePath, content);
  }
  const modulesTarget = join(target, vendorModuleDirectory);
  if (hadModules) {
    const stat = await lstat(modulesTarget).catch(() => undefined);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new Error("Refusing to replace a non-directory modules entry");
    await rm(modulesTarget, { recursive: true, force: true });
  }
  await writeFile(
    join(target, markerName),
    `${JSON.stringify({ generator: "errtraq", stack: stack.name, files: Object.keys(result.files), ...(modules.vendored ? { modules: true } : {}) }, null, 2)}\n`,
  );
  if (modules.vendored && modules.version)
    await vendorModules(
      modules.directory,
      modulesTarget,
      modules.vendored,
      modules.version,
    );
  const displayTarget = relative(repo, target).split(sep).join("/");
  const quotedTarget = `'${displayTarget.replaceAll("'", "'\\''")}'`;
  return `Generated Terraform in ${displayTarget}\nNext (from repository root): cd ${quotedTarget} && terraform init && terraform plan${placeholders ? "\nWarning: artifact paths are placeholders." : ""}`;
}
