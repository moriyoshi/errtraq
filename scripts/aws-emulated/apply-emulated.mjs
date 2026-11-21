import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { client, element } from "./client.mjs";
import { applyFifo } from "./fifo-apply.mjs";
import {
  assertPartialBatchSupport,
  checkConditionalUpdateGap,
  checkEventbridgeGap,
  checkStandaloneGaps,
} from "./gap-checks.mjs";
import { loadGaps, skipped } from "./gaps.mjs";
import {
  assertFunctionTransition,
  assertQueueTransition,
  assertRepeatPlan,
} from "./plan-check.mjs";
import { probeFifo } from "./probe-fifo.mjs";
import { runStandalone } from "./standalone.mjs";
import { providerOverride, terraformEnvironment } from "./terraform-config.mjs";
import { verifyCleanup, verifyDeployment } from "./verify-deployment.mjs";

const postgresOnly = process.argv.includes("--postgres-only");
const fifoOnly = process.argv.includes("--fifo-only");
const groupedOnly = process.argv.includes("--grouped-only");
const fifoOnlyComplete = Symbol("fifo-only complete");
const root = resolve(".");
const scratch = resolve(".agents-workspace/tmp");
const revision = "79c452d2bb2844abf771cfa4a497275c24b46489";
const binary =
  process.env.ERRTRAQ_WINTERBAUME_BINARY ??
  resolve(scratch, `winterbaume-${revision}/target/debug/winterbaume-server`);
const cache = resolve(scratch, "terraform-plugin-cache");
if (!existsSync(binary)) {
  console.log(
    "SKIP Terraform emulator integration: run pnpm aws-emulator:install first.",
  );
  process.exit(0);
}
const version = "6.73.0";
const platform = `${process.platform === "win32" ? "windows" : process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
const cached = resolve(
  cache,
  "registry.terraform.io/hashicorp/aws",
  version,
  platform,
);
if (
  !existsSync(cached) ||
  !readdirSync(cached).some((name) =>
    name.startsWith(`terraform-provider-aws_v${version}`),
  )
)
  throw new Error(
    `Missing cached AWS provider ${version}; run pnpm infra:validate first`,
  );
const gaps = loadGaps();
const temp = mkdtempSync(resolve(scratch, "m3a2-apply-"));
const modules = resolve(temp, "modules");
cpSync(resolve(root, "infra/modules"), modules, { recursive: true });
writeFileSync(
  resolve(modules, "aws/s3/emulator_override.tf"),
  'resource "aws_s3_bucket_ownership_controls" "this" { count = 0 }\n',
);
const socket = createServer();
await new Promise((yes, no) => {
  socket.once("error", no);
  socket.listen(0, "127.0.0.1", yes);
});
const port = socket.address().port;
await new Promise((yes, no) =>
  socket.close((error) => (error ? no(error) : yes())),
);
const endpoint = `http://127.0.0.1:${port}`;
const server = spawn(binary, ["--host", "127.0.0.1", "--port", String(port)], {
  stdio: ["ignore", "ignore", "pipe"],
});
let serverError = "",
  exited = false;
server.stderr.on("data", (data) => {
  serverError = (serverError + data).slice(-4000);
});
server.once("exit", () => {
  exited = true;
});
const env = terraformEnvironment(process.env, endpoint);
function run(command, args, cwd, allow = [0]) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, TF_DATA_DIR: resolve(cwd, ".terraform") },
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!allow.includes(result.status))
    throw new Error(
      `${command} ${args[0]} failed (${result.error?.message ?? result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
function tf(dir, ...args) {
  return run("terraform", [...args, "-no-color"], dir);
}
function json(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
try {
  let ready = false;
  for (let i = 0; i < 600; i++) {
    if (exited) throw new Error(`Emulator exited: ${serverError}`);
    try {
      await fetch(endpoint, {
        signal: AbortSignal.timeout(500),
        redirect: "error",
      });
      ready = true;
      break;
    } catch {
      await new Promise((yes) => setTimeout(yes, 100));
    }
  }
  if (!ready) throw new Error(`Emulator did not start: ${serverError}`);
  const c = client(endpoint);
  if (fifoOnly) {
    await applyFifo({ c, gaps, temp, modules, version, cache, endpoint, tf });
    throw fifoOnlyComplete;
  }
  await checkStandaloneGaps(c);
  skipped(gaps, "s3-ownership-delete");
  await checkConditionalUpdateGap(c);
  skipped(gaps, "dynamodb-conditional-atomicity");
  run("pnpm", ["build"], root);
  const sts = await c.request("sts", "/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "Action=GetCallerIdentity&Version=2011-06-15",
  });
  const account = element(sts.text, "Account");
  if (!account) throw new Error("Missing emulator account");
  await checkEventbridgeGap(c, account);
  if (groupedOnly) await probeFifo(endpoint);
  else if (!postgresOnly)
    await applyFifo({ c, gaps, temp, modules, version, cache, endpoint, tf });
  if (!postgresOnly && !groupedOnly)
    await runStandalone({
      c,
      gaps,
      temp,
      modules,
      version,
      cache,
      endpoint,
      account,
      tf,
      run,
    });
  // Apply grouped roots with only the two independently probed FIFO readback gaps removed.
  if (!postgresOnly) {
    const file = resolve(modules, "aws/sqs/main.tf");
    let source = readFileSync(file, "utf8");
    for (const from of [
      'deduplication_scope         = each.value.fifo ? "messageGroup" : null',
      'fifo_throughput_limit       = each.value.fifo ? "perMessageGroupId" : null',
    ]) {
      if (source.split(from).length !== 2)
        throw new Error("FIFO emulator override no longer matches");
      source = source.replace(from, `${from.split("=")[0]}= null`);
    }
    writeFileSync(file, source);
    skipped(gaps, "sqs-fifo");
  }
  const { deriveDeployment, resolveStack } = await import(
    "../../packages/core/dist/index.js"
  );
  const { generate } = await import("../../packages/infra-gen/dist/index.js");
  const original = (await import("../../stacks/aws-dynamodb.ts")).default;
  const { awsLambda } = await import(
    "../../packages/platforms/aws-lambda/dist/stack.js"
  );
  const { fixtures } = await import("../infra-roots.mjs");
  const variant = (base, changes) =>
    resolveStack({ ...Object.fromEntries(Object.entries(base)), ...changes });
  if (!postgresOnly) {
    const stack = resolveStack({
      ...Object.fromEntries(Object.entries(original)),
      name: "m3a2-shared",
      protection: "disposable",
    });
    const view = deriveDeployment(stack);
    const dir = resolve(temp, "shared");
    mkdirSync(dir, { recursive: true });
    const generated = generate(stack, {
      outputDirectory: dir,
      modulesDirectory: modules,
      generationEnv: {},
      artifactPaths: Object.fromEntries(
        view.functions.map((fn) => [fn.id, "artifact.zip"]),
      ),
    });
    if (generated.kind !== "terraform") throw new Error(generated.reason);
    for (const [file, content] of Object.entries(generated.files))
      writeFileSync(resolve(dir, file), content);
    json(
      resolve(dir, "emulator_override.tf.json"),
      providerOverride(endpoint, version),
    );
    writeFileSync(
      resolve(dir, "index.mjs"),
      'export const handler = async () => ({ statusCode: 200, body: "ok" });\n',
    );
    run("zip", ["-q", "artifact.zip", "index.mjs"], dir);
    console.log("Initializing generated shared stack");
    tf(dir, "init", "-backend=false", "-input=false", `-plugin-dir=${cache}`);
    console.log("Applying generated shared stack");
    tf(dir, "apply", "-auto-approve", "-input=false");
    console.log("PASS shared-stack apply");
    const observed = await verifyDeployment(c, stack, view, account);
    for (const mapping of observed.mappingForStack)
      assertPartialBatchSupport(mapping);
    console.log("PASS shared-stack API assertions");
    run(
      "terraform",
      [
        "plan",
        "-input=false",
        "-no-color",
        "-detailed-exitcode",
        "-out=repeat.tfplan",
      ],
      dir,
      [0, 2],
    );
    const repeat = JSON.parse(
      run("terraform", ["show", "-json", "-no-color", "repeat.tfplan"], dir),
    );
    const exceptions = assertRepeatPlan(repeat, gaps, stack.providers.aws.tags);
    for (const id of [
      "tags-dynamodb",
      "tags-iam",
      "tags-s3",
      "tags-lambda-mapping",
      "tags-eventbridge",
    ]) {
      if (!exceptions.has(id))
        throw new Error(
          `Emulator gap ${id} no longer reproduces; remove the exception`,
        );
      skipped(gaps, id);
    }
    console.log("PASS shared-stack repeat plan after named gap exclusions");
    tf(dir, "apply", "-auto-approve", "-input=false");
    await verifyDeployment(c, stack, view, account);
    console.log("PASS shared-stack second apply and API assertions");
    const perTopic = (await import("../../stacks/aws-dynamodb-per-topic.ts"))
      .default;
    function writeStack(next) {
      const deployment = deriveDeployment(next);
      const files = generate(next, {
        outputDirectory: dir,
        modulesDirectory: modules,
        generationEnv: {},
        artifactPaths: Object.fromEntries(
          deployment.functions.map((fn) => [fn.id, "artifact.zip"]),
        ),
      });
      if (files.kind !== "terraform") throw new Error(files.reason);
      for (const [file, content] of Object.entries(files.files))
        writeFileSync(resolve(dir, file), content);
      return deployment;
    }
    function changePlan(label) {
      run(
        "terraform",
        [
          "plan",
          "-input=false",
          "-no-color",
          "-detailed-exitcode",
          `-out=${label}.tfplan`,
        ],
        dir,
        [0, 2],
      );
      return JSON.parse(
        run(
          "terraform",
          ["show", "-json", "-no-color", `${label}.tfplan`],
          dir,
        ),
      );
    }
    const perTopicSameName = variant(perTopic, {
      name: stack.name,
      protection: "disposable",
    });
    const perTopicView = writeStack(perTopicSameName);
    if (
      JSON.stringify(
        view.triggers.filter((t) => t.kind === "queue").map((t) => t.physical),
      ) !== JSON.stringify(["shared", "record"]) ||
      JSON.stringify(
        perTopicView.triggers
          .filter((t) => t.kind === "queue")
          .map((t) => t.physical),
      ) !== JSON.stringify(["ingest", "record"])
    )
      throw new Error(
        "Example stacks no longer have exactly the expected ingest route",
      );
    assertQueueTransition(changePlan("queue-change"), view, perTopicView);
    console.log("PASS example shared-to-per-topic change plan");
    const partialSplit = variant(stack, {
      platform: awsLambda({
        roles: ["ingest", "api", "consumer", "record", "cron"],
        split: ["ingest", "api", "consumer"],
      }),
    });
    const splitView = writeStack(partialSplit);
    assertFunctionTransition(changePlan("split-change"), view, splitView);
    console.log("PASS example unsplit change plan");
    tf(dir, "apply", "-auto-approve", "-input=false");
    await verifyDeployment(c, partialSplit, splitView, account);
    writeStack(stack);
    assertFunctionTransition(changePlan("resplit-change"), splitView, view);
    console.log("PASS example split change plan");
    writeStack(partialSplit);
    console.log("Destroying generated shared stack");
    tf(dir, "destroy", "-auto-approve", "-input=false");
    await verifyCleanup(c, stack.name);
    console.log("PASS shared-stack destroy and API inventory");
    const second = variant(perTopic, {
      name: "m3a2-per-topic",
      protection: "disposable",
    });
    const secondView = deriveDeployment(second);
    const secondDir = resolve(temp, "per-topic");
    mkdirSync(secondDir, { recursive: true });
    const secondFiles = generate(second, {
      outputDirectory: secondDir,
      modulesDirectory: modules,
      generationEnv: {},
      artifactPaths: Object.fromEntries(
        secondView.functions.map((fn) => [fn.id, "artifact.zip"]),
      ),
    });
    if (secondFiles.kind !== "terraform") throw new Error(secondFiles.reason);
    for (const [file, content] of Object.entries(secondFiles.files))
      writeFileSync(resolve(secondDir, file), content);
    json(
      resolve(secondDir, "emulator_override.tf.json"),
      providerOverride(endpoint, version),
    );
    writeFileSync(
      resolve(secondDir, "index.mjs"),
      'export const handler = async () => ({ statusCode: 200, body: "ok" });\n',
    );
    run("zip", ["-q", "artifact.zip", "index.mjs"], secondDir);
    tf(
      secondDir,
      "init",
      "-backend=false",
      "-input=false",
      `-plugin-dir=${cache}`,
    );
    console.log("Applying generated per-topic stack");
    tf(secondDir, "apply", "-auto-approve", "-input=false");
    const secondObserved = await verifyDeployment(
      c,
      second,
      secondView,
      account,
    );
    for (const mapping of secondObserved.mappingForStack)
      assertPartialBatchSupport(mapping);
    run(
      "terraform",
      [
        "plan",
        "-input=false",
        "-no-color",
        "-detailed-exitcode",
        "-out=repeat.tfplan",
      ],
      secondDir,
      [0, 2],
    );
    const secondRepeat = JSON.parse(
      run(
        "terraform",
        ["show", "-json", "-no-color", "repeat.tfplan"],
        secondDir,
      ),
    );
    const secondExceptions = assertRepeatPlan(
      secondRepeat,
      gaps,
      second.providers.aws.tags,
    );
    for (const id of [
      "tags-dynamodb",
      "tags-iam",
      "tags-s3",
      "tags-lambda-mapping",
      "tags-eventbridge",
    ]) {
      if (!secondExceptions.has(id))
        throw new Error(`Emulator gap ${id} no longer reproduces`);
      skipped(gaps, id);
    }
    console.log(
      "PASS per-topic API assertions and repeat plan after named gap exclusions",
    );
    tf(secondDir, "apply", "-auto-approve", "-input=false");
    await verifyDeployment(c, second, secondView, account);
    console.log("PASS per-topic second apply and API assertions");
    tf(secondDir, "destroy", "-auto-approve", "-input=false");
    await verifyCleanup(c, second.name);
    console.log("PASS per-topic destroy and API inventory");
    if (groupedOnly) throw fifoOnlyComplete;
    const featureStack = variant(fixtures.archive, {
      name: "m3a2-feature",
      protection: "disposable",
      features: { notifications: true },
      queue: original.queue,
    });
    const featureNext = variant(featureStack, { queue: perTopic.queue });
    const featureDir = resolve(temp, "feature");
    mkdirSync(featureDir, { recursive: true });
    function writeFeature(next) {
      const deployment = deriveDeployment(next);
      const result = generate(next, {
        outputDirectory: featureDir,
        modulesDirectory: modules,
        generationEnv: {},
        artifactPaths: Object.fromEntries(
          deployment.functions.map((fn) => [fn.id, "artifact.zip"]),
        ),
      });
      if (result.kind !== "terraform") throw new Error(result.reason);
      for (const [file, content] of Object.entries(result.files))
        writeFileSync(resolve(featureDir, file), content);
      return deployment;
    }
    const featureView = writeFeature(featureStack);
    json(
      resolve(featureDir, "emulator_override.tf.json"),
      providerOverride(endpoint, version),
    );
    writeFileSync(
      resolve(featureDir, "index.mjs"),
      'export const handler = async () => ({ statusCode: 200, body: "ok" });\n',
    );
    run("zip", ["-q", "artifact.zip", "index.mjs"], featureDir);
    tf(
      featureDir,
      "init",
      "-backend=false",
      "-input=false",
      `-plugin-dir=${cache}`,
    );
    console.log("Applying feature-enabled shared stack for change-plan check");
    tf(featureDir, "apply", "-auto-approve", "-input=false");
    await verifyDeployment(c, featureStack, featureView, account);
    const featureNextView = writeFeature(featureNext);
    const featureKeys = featureNextView.triggers
      .filter((t) => t.kind === "queue")
      .map((t) => t.physical)
      .sort();
    if (
      JSON.stringify(featureKeys) !==
      JSON.stringify(["archive_project", "ingest", "notifications", "record"])
    )
      throw new Error("Feature fixture did not activate all four topics");
    run(
      "terraform",
      [
        "plan",
        "-input=false",
        "-no-color",
        "-detailed-exitcode",
        "-out=change.tfplan",
      ],
      featureDir,
      [0, 2],
    );
    const featurePlan = JSON.parse(
      run(
        "terraform",
        ["show", "-json", "-no-color", "change.tfplan"],
        featureDir,
      ),
    );
    assertQueueTransition(featurePlan, featureView, featureNextView);
    console.log("PASS three-topic shared-to-per-topic change plan");
    writeFeature(featureStack);
    tf(featureDir, "destroy", "-auto-approve", "-input=false");
    await verifyCleanup(c, featureStack.name);
    console.log("PASS feature fixture destroy and API inventory");
  }

  // Confirm the VPC readback gap before excluding the affected block in a temporary copy.
  const vpcProbe = "m3f2-vpc-probe";
  const probeBody = {
    FunctionName: vpcProbe,
    Runtime: "nodejs22.x",
    Role: `arn:aws:iam::${account}:role/test`,
    Handler: "index.handler",
    Code: { ZipFile: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==" },
    VpcConfig: {
      SubnetIds: ["subnet-12345678"],
      SecurityGroupIds: ["sg-12345678"],
    },
  };
  const createdVpc = JSON.parse(
    (
      await c.request("lambda", "/2015-03-31/functions/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(probeBody),
      })
    ).text,
  );
  const readVpc = JSON.parse(
    (await c.request("lambda", `/2015-03-31/functions/${vpcProbe}`)).text,
  ).Configuration;
  await c.request("lambda", `/2015-03-31/functions/${vpcProbe}`, {
    method: "DELETE",
  });
  if (createdVpc.VpcConfig || readVpc.VpcConfig)
    throw new Error(
      "Emulator VPC gap no longer reproduces; remove the temporary override and assert VPC readback",
    );
  skipped(gaps, "lambda-vpc-readback");
  const lambdaModule = resolve(modules, "aws/lambda-app/main.tf");
  const moduleSource = readFileSync(lambdaModule, "utf8");
  const vpcBlock = "for_each = local.vpc_enabled ? [1] : []";
  if (moduleSource.split(vpcBlock).length !== 2)
    throw new Error("Cannot isolate the VPC block in the copied Lambda module");
  writeFileSync(lambdaModule, moduleSource.replace(vpcBlock, "for_each = []"));
  const pgStack = variant(fixtures["postgres-vpc"], {
    name: "m3f2-postgres",
    protection: "disposable",
  });
  const pgView = deriveDeployment(pgStack);
  const pgDir = resolve(temp, "postgres-vpc");
  mkdirSync(pgDir, { recursive: true });
  const pgGenerated = generate(pgStack, {
    outputDirectory: pgDir,
    modulesDirectory: modules,
    generationEnv: {},
    artifactPaths: Object.fromEntries(
      pgView.functions.map((fn) => [fn.id, "artifact.zip"]),
    ),
  });
  if (pgGenerated.kind !== "terraform") throw new Error(pgGenerated.reason);
  for (const [file, content] of Object.entries(pgGenerated.files))
    writeFileSync(resolve(pgDir, file), content);
  json(
    resolve(pgDir, "emulator_override.tf.json"),
    providerOverride(endpoint, version),
  );
  writeFileSync(
    resolve(pgDir, "index.mjs"),
    'export const handler = async () => ({ statusCode: 200, body: "ok" });\n',
  );
  run("zip", ["-q", "artifact.zip", "index.mjs"], pgDir);
  tf(pgDir, "init", "-backend=false", "-input=false", `-plugin-dir=${cache}`);
  console.log("Applying generated PostgreSQL IAM stack");
  tf(pgDir, "apply", "-auto-approve", "-input=false");
  await verifyDeployment(c, pgStack, pgView, account);
  console.log(
    "PASS PostgreSQL IAM generated stack and role policies (VPC readback excluded)",
  );
  tf(pgDir, "destroy", "-auto-approve", "-input=false");
  await verifyCleanup(c, pgStack.name);
  console.log("PASS PostgreSQL IAM stack destroy and API inventory");
} catch (error) {
  if (error !== fifoOnlyComplete) throw error;
} finally {
  server.kill("SIGTERM");
  await new Promise((yes) => {
    if (server.exitCode !== null || server.signalCode !== null) yes();
    else server.once("exit", yes);
  });
}
