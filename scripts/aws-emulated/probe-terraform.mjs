import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { client, element } from "./client.mjs";
import { defaultBinary } from "./emulator-binary.mjs";
import { providerOverride, terraformEnvironment } from "./terraform-config.mjs";

const root = resolve(".");
const scratch = resolve(".agents-workspace/tmp");
const binary = defaultBinary();
const cache = resolve(scratch, "terraform-plugin-cache");
if (!existsSync(binary)) {
  console.log(
    "SKIP Terraform emulator probe: run pnpm aws-emulator:install first.",
  );
  process.exit(0);
}
const versions = ["6.32.1", "6.73.0"];
const targets = [
  "dynamodb",
  "dynamodb-protected",
  "sqs",
  "s3",
  "lambda-app",
  "generated-root",
];
const selectedVersion = process.env.ERRTRAQ_PROBE_PROVIDER;
const selectedTarget = process.env.ERRTRAQ_PROBE_TARGET;
if (selectedVersion && !versions.includes(selectedVersion))
  throw new Error("Unknown provider version");
if (selectedTarget && !targets.includes(selectedTarget))
  throw new Error("Unknown probe target");
for (const version of versions.filter(
  (version) => !selectedVersion || version === selectedVersion,
)) {
  const platform = `${process.platform === "win32" ? "windows" : process.platform}_${process.arch === "x64" ? "amd64" : process.arch}`;
  const dir = resolve(
    cache,
    "registry.terraform.io/hashicorp/aws",
    version,
    platform,
  );
  if (
    !existsSync(dir) ||
    !readdirSync(dir).some((name) =>
      name.startsWith(`terraform-provider-aws_v${version}`),
    )
  )
    throw new Error(
      `AWS provider ${version} absent from cache; run pnpm infra:validate first.`,
    );
}
const temp = mkdtempSync(resolve(scratch, "m3a2-terraform-probe-"));
const socket = createServer();
await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", resolve);
});
const port = socket.address().port;
await new Promise((resolve, reject) =>
  socket.close((error) => (error ? reject(error) : resolve())),
);
const endpoint = `http://127.0.0.1:${port}`;
const server = spawn(binary, ["--host", "127.0.0.1", "--port", String(port)], {
  stdio: ["ignore", "ignore", "pipe"],
});
let serverError = "";
server.stderr.on("data", (data) => {
  serverError = (serverError + data).slice(-4000);
});
let exited = false;
server.once("exit", () => {
  exited = true;
});
const env = terraformEnvironment(process.env, endpoint);
function execute(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    error: result.error?.message,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
function terraform(args, dir, debug = false) {
  return execute("terraform", [...args, "-no-color"], dir, {
    TF_DATA_DIR: resolve(dir, ".terraform"),
    ...(debug
      ? { TF_LOG: "DEBUG", TF_LOG_PATH: resolve(dir, "provider-debug.log") }
      : {}),
  });
}
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error(`Emulator exited: ${serverError}`);
    try {
      await fetch(endpoint, {
        signal: AbortSignal.timeout(500),
        redirect: "error",
      });
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) throw new Error(`Emulator did not start: ${serverError}`);
  const api = client(endpoint);
  const identity = await api.request("sts", "/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "Action=GetCallerIdentity&Version=2011-06-15",
  });
  const account = element(identity.text, "Account");
  if (!account) throw new Error("Emulator STS did not return an account");
  const name = `m3a2-${Date.now().toString(36)}`;
  const moduleFixture = {
    dynamodb: { name, tags: {}, purpose: "store", protection: "disposable" },
    sqs: {
      name,
      tags: {},
      physical_queues: {
        shared: {
          visibility_timeout_sec: 180,
          dlq_enabled: true,
          max_receive_count: 3,
        },
      },
    },
    s3: {
      name,
      tags: {},
      staging_prefix: "archive-staging/",
      protection: "disposable",
    },
    "lambda-app": {
      name,
      tags: {},
      functions: {
        all: {
          roles: ["ingest", "api", "consumer", "cron"],
          http: ["ingest", "api"],
          artifact: "artifact.zip",
          memory_mb: 256,
          timeout_sec: 30,
          architecture: "x86_64",
          environment: { TEST: "value" },
          secrets: {},
          policies: [
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["sqs:ReceiveMessage"],
                  Resource: [`arn:aws:sqs:us-east-1:${account}:${name}`],
                },
              ],
            }),
          ],
          secret_reads: [],
        },
      },
      queue_triggers: {
        shared: {
          function_id: "all",
          resource: `arn:aws:sqs:us-east-1:${account}:${name}`,
          topics: ["ingest"],
          visibility_timeout_sec: 180,
        },
      },
      cron_triggers: {
        recovery: {
          function_id: "all",
          schedule: "0 * * * *",
          dlq_arn: `arn:aws:sqs:us-east-1:${account}:${name}`,
        },
      },
    },
  };
  const build = execute("pnpm", ["build"], root);
  if (build.status !== 0)
    throw new Error(`Workspace build failed: ${build.stderr}\n${build.stdout}`);
  const { deriveDeployment } = await import(
    "../../packages/core/dist/index.js"
  );
  const { generate } = await import("../../packages/infra-gen/dist/index.js");
  const originalStack = (await import("../../stacks/aws-dynamodb.ts")).default;
  const { resolveStack } = await import("../../packages/core/dist/index.js");
  const results = [];
  for (const version of versions.filter(
    (version) => !selectedVersion || version === selectedVersion,
  ))
    for (const target of targets.filter(
      (target) => !selectedTarget || target === selectedTarget,
    )) {
      console.log(`Probing ${target} with AWS provider ${version}`);
      const stack = resolveStack({
        ...Object.fromEntries(Object.entries(originalStack)),
        name: `${originalStack.name}-${version.replaceAll(".", "-")}`,
      });
      const dir = resolve(temp, version, target);
      mkdirSync(dir, { recursive: true });
      writeJson(
        resolve(dir, "emulator_override.tf.json"),
        providerOverride(endpoint, version),
      );
      writeFileSync(
        resolve(dir, "index.mjs"),
        'export const handler = async () => ({ statusCode: 200, body: "ok" });\n',
      );
      const zip = execute("zip", ["-q", "artifact.zip", "index.mjs"], dir);
      if (zip.status !== 0) throw new Error(`zip failed: ${zip.stderr}`);
      if (target === "generated-root") {
        const view = deriveDeployment(stack);
        const generated = generate(stack, {
          outputDirectory: dir,
          modulesDirectory: resolve(root, "infra/modules"),
          generationEnv: {},
          artifactPaths: Object.fromEntries(
            view.functions.map((fn) => [fn.id, "artifact.zip"]),
          ),
        });
        if (generated.kind !== "terraform") throw new Error(generated.reason);
        for (const [file, contents] of Object.entries(generated.files))
          writeFileSync(resolve(dir, file), contents);
      } else {
        writeJson(resolve(dir, "main.tf.json"), {
          terraform: {
            required_providers: {
              aws: { source: "hashicorp/aws", version: `= ${version}` },
            },
          },
          provider: { aws: [{ region: "us-east-1" }] },
          module: {
            test: {
              source: resolve(
                root,
                "infra/modules/aws",
                target === "dynamodb-protected" ? "dynamodb" : target,
              ),
              ...moduleFixture[
                target === "dynamodb-protected" ? "dynamodb" : target
              ],
              ...(target === "dynamodb-protected"
                ? { protection: "production" }
                : {}),
              name: `${name}-${version.replaceAll(".", "-")}`,
            },
          },
        });
      }
      const init = terraform(
        ["init", "-backend=false", "-input=false", `-plugin-dir=${cache}`],
        dir,
      );
      writeFileSync(resolve(dir, "init.log"), `${init.stdout}\n${init.stderr}`);
      if (init.status !== 0)
        throw new Error(
          `Terraform init failed for ${target} ${version}: ${init.stderr}\n${init.stdout}`,
        );
      const apply = terraform(
        ["apply", "-auto-approve", "-input=false", "-parallelism=10"],
        dir,
        true,
      );
      writeFileSync(
        resolve(dir, "apply.log"),
        `${apply.stdout}\n${apply.stderr}`,
      );
      console.log(
        `  APPLY ${apply.status === 0 ? "PASS" : "FAILED"}${apply.error ? ` (${apply.error})` : ""}`,
      );
      if (target === "dynamodb-protected" && apply.status === 0) {
        const destroy = terraform(
          ["destroy", "-auto-approve", "-input=false"],
          dir,
        );
        writeFileSync(
          resolve(dir, "destroy.log"),
          `${destroy.stdout}\n${destroy.stderr}`,
        );
        console.log(
          `  Protected table destroy exit: ${destroy.status} (nonzero expected)`,
        );
      }
      if (target === "lambda-app" && apply.status === 0) {
        const plan = terraform(
          ["plan", "-input=false", "-detailed-exitcode"],
          dir,
        );
        writeFileSync(
          resolve(dir, "second-plan.log"),
          `${plan.stdout}\n${plan.stderr}`,
        );
        console.log(`  Lambda second-plan exit: ${plan.status}`);
      }
      const fixtureName = `${name}-${version.replaceAll(".", "-")}`;
      try {
        if (target === "dynamodb" && apply.status === 0) {
          const table = `${fixtureName}-store`;
          const observations = {};
          for (const action of [
            "DescribeTable",
            "DescribeTimeToLive",
            "DescribeContinuousBackups",
          ])
            observations[action] = await api.dynamo(action, {
              TableName: table,
            });
          writeJson(resolve(dir, "api-observations.json"), observations);
        }
        if (target === "s3") {
          const listing = await api.request("s3", "/");
          const prefix = `${fixtureName.toLowerCase().slice(0, 30)}-`;
          const bucket = [...listing.text.matchAll(/<Name>([^<]+)<\/Name>/g)]
            .map((match) => match[1])
            .find((value) => value.startsWith(prefix));
          if (bucket) {
            const observations = {};
            for (const query of [
              "policy",
              "publicAccessBlock",
              "encryption",
              "versioning",
              "lifecycle",
            ]) {
              try {
                const response = await api.request("s3", `/${bucket}?${query}`);
                observations[query] = {
                  status: response.status,
                  body: response.text,
                  headers: Object.fromEntries(response.headers),
                };
              } catch (error) {
                observations[query] = { error: error.message };
              }
            }
            try {
              const response = await api.request("s3", `/${bucket}/probe`, {
                method: "PUT",
                body: "test",
              });
              observations.httpPut = {
                status: response.status,
                body: response.text,
              };
            } catch (error) {
              observations.httpPut = { error: error.message };
            }
            writeJson(resolve(dir, "api-observations.json"), observations);
          }
        }
        if (target === "sqs" && apply.status === 0) {
          const queues = {};
          for (const suffix of ["shared", "shared-dlq"]) {
            const { QueueUrl } = await api.sqs("GetQueueUrl", {
              QueueName: `${fixtureName}-${suffix}`,
            });
            queues[suffix] = await api.sqs("GetQueueAttributes", {
              QueueUrl,
              AttributeNames: ["All"],
            });
          }
          writeJson(resolve(dir, "api-observations.json"), queues);
        }
        if (target === "lambda-app" && apply.status === 0) {
          const invocation = await api.request(
            "lambda",
            `/2015-03-31/functions/${fixtureName}-all/invocations`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            },
          );
          const iam = await api.request("iam", "/", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              Action: "GetRolePolicy",
              Version: "2010-05-08",
              RoleName: `${fixtureName}-all`,
              PolicyName: "capability-all-0",
            }).toString(),
          });
          const policy = await api.request(
            "lambda",
            `/2015-03-31/functions/${fixtureName}-all/policy`,
          );
          const mappings = await api.request(
            "lambda",
            `/2015-03-31/event-source-mappings/?FunctionName=${fixtureName}-all`,
          );
          const targets = await api.request("events", "/", {
            method: "POST",
            headers: {
              "content-type": "application/x-amz-json-1.1",
              "x-amz-target": "AWSEvents.ListTargetsByRule",
            },
            body: JSON.stringify({ Rule: `${fixtureName}-recovery` }),
          });
          writeJson(resolve(dir, "api-observations.json"), {
            iam: iam.text,
            policy: JSON.parse(policy.text),
            mappings: JSON.parse(mappings.text),
            targets: JSON.parse(targets.text),
          });
          writeJson(resolve(dir, "invocation.json"), {
            status: invocation.status,
            body: invocation.text,
            expected: { statusCode: 200, body: "ok" },
          });
          console.log(
            `  Lambda Invoke returned ${invocation.text}; expected handler response {statusCode:200,body:ok}`,
          );
        }
      } catch (error) {
        console.log(`  API observation failed: ${error.message}`);
      }
      results.push({
        target,
        version,
        status: apply.status,
        error: apply.error,
        log: resolve(dir, "apply.log"),
      });
    }
  writeJson(resolve(temp, "results.json"), results);
  console.log(`Probe logs: ${temp}`);
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) resolve();
    else server.once("exit", resolve);
  });
}
