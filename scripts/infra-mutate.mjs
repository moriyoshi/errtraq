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
import { dynamoMetadataProtection } from "./infra-security-contract.mjs";
import { capturedShape, checkShape, shapeFixture } from "./infra-shapes.mjs";

const root = resolve("infra/modules/aws");
const scratch = resolve(".agents-workspace/tmp");
const cache = resolve(scratch, "terraform-plugin-cache");
mkdirSync(scratch, { recursive: true });
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
const moduleMutations = mutations.filter((item) => item.module);
const rootMutations = mutations.filter((item) => item.root);
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
  if (!source.includes('version = ">= 6.32.1, < 7.0"'))
    throw new Error(`Unexpected provider constraint for ${component}`);
  writeFileSync(
    versions,
    source.replace('version = ">= 6.32.1, < 7.0"', `version = "= ${version}"`),
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
  const build = spawnSync("pnpm", ["build"], { stdio: "inherit" });
  if (build.status !== 0) throw new Error("Workspace build failed");
  const { prepareRoot } = await import("./infra-roots.mjs");
  for (const component of [
    ...new Set(moduleMutations.map((item) => item.module)),
  ]) {
    const target = prepare(component, `baseline-${component}`);
    const validated = terraform(["validate", "-no-color"], target);
    const tested = terraform(
      ["test", "-no-color", "-filter=tests/contract.tftest.hcl"],
      target,
    );
    if (component === "dynamodb" && !dynamoMetadataProtection(target))
      throw new Error("DynamoDB metadata protection baseline failed");
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
  for (const mutation of moduleMutations) {
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
      mutation.module === "dynamodb" && !dynamoMetadataProtection(target)
        ? "source"
        : "",
    ].filter(Boolean);
    console.log(
      `${mutation.id}: ${caught.length ? caught.join(", ") : "MISSED"}`,
    );
    if (!caught.length) failures.push(mutation.id);
  }
  for (const mutation of rootMutations) {
    const target = prepareRoot(
      resolve(temp, mutation.id),
      mutation.root,
      version,
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
      throw new Error(`Root init failed: ${init.stdout} ${init.stderr}`);
    const baseline = terraform(["test", "-no-color"], target);
    if (baseline.status !== 0)
      throw new Error(
        `Root baseline failed: ${baseline.stdout} ${baseline.stderr}`,
      );
    const path = resolve(target, "main.tf.json");
    const main = JSON.parse(readFileSync(path, "utf8"));
    const platform = main.module.platform;
    switch (mutation.operation) {
      case "rate-drop-api-kv-policy":
      case "rate-drop-record-kv-policy":
      case "rate-drop-kv-policy": {
        const role =
          mutation.operation === "rate-drop-api-kv-policy"
            ? "api"
            : mutation.operation === "rate-drop-record-kv-policy"
              ? "record"
              : "consumer";
        const policies = platform.functions[role].policies;
        const index = policies.findIndex((p) => p.includes("module.kv"));
        if (index < 0) throw new Error("KV policy mutation target missing");
        policies.splice(index, 1);
        break;
      }
      case "rate-drop-project-read-policy": {
        const policies = platform.functions.consumer.policies;
        const index = policies.findIndex((p) => p.includes("module.store"));
        if (index < 0) throw new Error("Store policy mutation target missing");
        policies.splice(index, 1);
        break;
      }
      case "rate-drop-store-binding":
        delete platform.functions.consumer.environment.ERRTRAQ_STORE_TABLE;
        break;
      case "rate-add-store-to-consumer":
        platform.functions.consumer.environment.ERRTRAQ_STORE_TABLE =
          platform.functions.record.environment.ERRTRAQ_STORE_TABLE;
        break;
      case "rate-add-record-store-policy-to-consumer":
        platform.functions.consumer.policies.push(
          ...platform.functions.record.policies.filter((p) =>
            p.includes("module.store"),
          ),
        );
        break;
      case "rate-drop-kv-binding":
        delete platform.functions.consumer.environment.ERRTRAQ_KV_TABLE;
        break;
      case "rate-drop-api-kv-binding":
        delete platform.functions.api.environment.ERRTRAQ_KV_TABLE;
        break;
      case "rate-add-api-kv-binding":
        platform.functions.api.environment.ERRTRAQ_KV_TABLE =
          platform.functions.ingest.environment.ERRTRAQ_KV_TABLE;
        break;
      case "rate-drop-record-kv-binding":
        delete platform.functions.record.environment.ERRTRAQ_KV_TABLE;
        break;
      case "rate-add-kv-to-record":
        platform.functions.record.environment.ERRTRAQ_KV_TABLE =
          platform.functions.ingest.environment.ERRTRAQ_KV_TABLE;
        break;
      case "drop-policy":
        platform.functions.ingest.policies.pop();
        break;
      case "wrong-function-policy":
        platform.functions.ingest.policies.push(
          platform.functions.api.policies.pop(),
        );
        break;
      case "drop-binding":
        delete platform.functions.ingest.environment[
          Object.keys(platform.functions.ingest.environment)[0]
        ];
        break;
      case "drop-trigger":
        delete platform.queue_triggers.shared;
        break;
      case "unescaped-literal": {
        const environment = platform.functions.ingest.environment;
        const key = Object.keys(environment).find(
          (item) => environment[item] === "https://example.test/$${literal}",
        );
        if (!key) throw new Error("Literal mutation target missing");
        environment[key] = "https://example.test/$" + "{literal}";
        break;
      }
      case "drop-function-alarm-topic":
        delete platform.alarm_topic_arn;
        break;
      case "drop-queue-alarm-topic":
        delete main.module.queue.alarm_topic_arn;
        break;
      case "drop-dlq":
        main.module.queue.physical_queues.record.dlq_enabled = false;
        break;
      default:
        throw new Error(`Unknown root mutation ${mutation.operation}`);
    }
    writeFileSync(path, `${JSON.stringify(main, null, 2)}\n`);
    const validation = terraform(["validate", "-no-color"], target);
    const tests = terraform(["test", "-no-color"], target);
    const caught = [
      validation.status !== 0 ? "validate" : "",
      tests.status !== 0 ? "tests" : "",
    ].filter(Boolean);
    console.log(
      `${mutation.id}: ${caught.length ? caught.join(", ") : "MISSED"}`,
    );
    if (!caught.length) failures.push(mutation.id);
  }
  if (failures.length)
    throw new Error(`Mutations not detected: ${failures.join(", ")}`);
  console.log(
    `All ${moduleMutations.length} module and ${rootMutations.length} generated-root mutations detected.`,
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
