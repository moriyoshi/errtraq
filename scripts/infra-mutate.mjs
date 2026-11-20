import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { capturedShape, checkShape, shapeFixture } from "./infra-shapes.mjs";

const root = resolve("infra/modules/aws");
const scratch = resolve(".agents-workspace/tmp");
const cache = resolve(scratch, "terraform-plugin-cache");
const temp = mkdtempSync(resolve(scratch, "terraform-mutations-"));
const version = "6.73.0";
const platform = `${process.platform === "win32" ? "windows" : process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
if (
  !existsSync(
    resolve(
      cache,
      "registry.terraform.io",
      "hashicorp",
      "aws",
      version,
      platform,
    ),
  )
)
  throw new Error("Provider is not cached; run pnpm infra:validate first");
const mutations = JSON.parse(
  readFileSync(resolve("scripts/infra-mutations.json"), "utf8"),
);
function terraform(args, cwd) {
  const env = {
    ...process.env,
    TF_DATA_DIR: resolve(cwd, ".terraform"),
    TF_IN_AUTOMATION: "1",
    CHECKPOINT_DISABLE: "1",
  };
  delete env.TF_PLUGIN_CACHE_DIR;
  const result = spawnSync("terraform", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
function prepare(component, label) {
  const target = resolve(temp, label);
  mkdirSync(target, { recursive: true });
  cpSync(resolve(root, component), target, { recursive: true });
  const versions = resolve(target, "versions.tf");
  const source = readFileSync(versions, "utf8");
  if (!source.includes('version = ">= 6.30.0, < 7.0"'))
    throw new Error(`Unexpected provider constraint for ${component}`);
  writeFileSync(
    versions,
    source.replace('version = ">= 6.30.0, < 7.0"', `version = "= ${version}"`),
  );
  const init = terraform(
    [
      "init",
      "-backend=false",
      "-input=false",
      "-no-color",
      `-plugin-dir=${cache}`,
    ],
    target,
  );
  if (init.status !== 0)
    throw new Error(
      `Initialization failed for ${component}: ${init.stderr} ${init.stdout}`,
    );
  return target;
}
function runShape(target, component) {
  const fixture = resolve(target, "tests", "shapes.tftest.hcl");
  writeFileSync(
    fixture,
    shapeFixture(
      readFileSync(resolve(target, "tests", "contract.tftest.hcl"), "utf8"),
    ),
  );
  const run = terraform(
    [
      "test",
      "-json",
      "-verbose",
      "-no-color",
      "-filter=tests/shapes.tftest.hcl",
    ],
    target,
  );
  if (run.status !== 0) return { available: false, differs: false };
  const value = capturedShape(run.stdout, component);
  try {
    checkShape(component, value);
    return { available: true, differs: false };
  } catch {
    return { available: true, differs: true };
  }
}
try {
  for (const component of [...new Set(mutations.map((item) => item.module))]) {
    const target = prepare(component, `baseline-${component}`);
    const validated = terraform(["validate", "-no-color"], target);
    const tested = terraform(
      ["test", "-no-color", "-filter=tests/contract.tftest.hcl"],
      target,
    );
    if (validated.status !== 0 || tested.status !== 0)
      throw new Error(
        `Baseline failed for ${component}: ${tested.stdout} ${tested.stderr} ${validated.stderr}`,
      );
    const actual = runShape(target, component);
    if (!actual.available || actual.differs)
      throw new Error(`Baseline output shape failed for ${component}`);
    console.log(`baseline ${component}: passed`);
  }
  const failures = [];
  for (const mutation of mutations) {
    const target = prepare(mutation.module, mutation.id);
    const file = resolve(target, mutation.file);
    const source = readFileSync(file, "utf8");
    if (source.split(mutation.find).length !== 2)
      throw new Error(`${mutation.id} must match exactly once`);
    writeFileSync(file, source.replace(mutation.find, mutation.replace));
    const validation = terraform(["validate", "-no-color"], target);
    const tests = terraform(
      ["test", "-no-color", "-filter=tests/contract.tftest.hcl"],
      target,
    );
    const result = runShape(target, mutation.module);
    const caught = [
      validation.status !== 0 ? "validate" : "",
      tests.status !== 0 ? "tests" : "",
      result.differs ? "shape" : "",
    ].filter(Boolean);
    console.log(
      `${mutation.id}: ${caught.length ? caught.join(", ") : "MISSED"}`,
    );
    if (!caught.length) failures.push(mutation.id);
  }
  if (failures.length)
    throw new Error(`Mutations not detected: ${failures.join(", ")}`);
  console.log(`All ${mutations.length} mutations detected.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
