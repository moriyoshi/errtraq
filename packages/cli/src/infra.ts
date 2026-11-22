import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  containsLocalPath,
  deriveDeployment,
  type ResolvedStack,
} from "@errtraq/core";
import { generate } from "@errtraq/infra-gen";
import type { BuildManifest } from "./build.js";

export async function repositoryRoot(start: string): Promise<string> {
  let current = await realpath(start);
  while (true) {
    try {
      await lstat(join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {
      /* try parent */
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("Cannot find repository root");
    current = parent;
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
export async function generateInfra(
  stack: ResolvedStack,
  repo: string,
  output: string,
  buildDirectory: string,
  allowMissing: boolean,
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
  const result = generate(stack, {
    outputDirectory: resolve(output),
    modulesDirectory: resolve(repo, "infra/modules"),
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
      )
    )
      throw new Error("Invalid generator marker");
    if (marker.stack !== stack.name)
      throw new Error(`Output directory belongs to stack ${marker.stack}`);
    old = marker.files;
    if (
      entries.some(
        (entry) =>
          entry !== markerName &&
          !old.includes(entry) &&
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
  await writeFile(
    join(target, markerName),
    `${JSON.stringify({ generator: "errtraq", stack: stack.name, files: Object.keys(result.files) }, null, 2)}\n`,
  );
  const displayTarget = relative(repo, target).split(sep).join("/");
  const quotedTarget = `'${displayTarget.replaceAll("'", "'\\''")}'`;
  return `Generated Terraform in ${displayTarget}\nNext (from repository root): cd ${quotedTarget} && terraform init && terraform plan${placeholders ? "\nWarning: artifact paths are placeholders." : ""}`;
}
