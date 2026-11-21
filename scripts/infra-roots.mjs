import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { postgres } from "../packages/adapters/store-sql/dist/postgres-stack.js";
import {
  deriveDeployment,
  out,
  resolveStack,
  variable,
} from "../packages/core/dist/index.js";
import {
  generate,
  renderInfraValue,
} from "../packages/infra-gen/dist/index.js";
import { awsLambda } from "../packages/platforms/aws-lambda/dist/stack.js";
import shared from "../stacks/aws-dynamodb.ts";
import perTopic from "../stacks/aws-dynamodb-per-topic.ts";

const policy = JSON.stringify({ Version: "2012-10-17", Statement: [] });
const literal = "https://example.test/$" + "{literal}";
function variant(base, changes) {
  return resolveStack({
    ...Object.fromEntries(Object.entries(base)),
    ...changes,
  });
}
export const fixtures = {
  shared,
  "per-topic": perTopic,
  "postgres-vpc": variant(shared, {
    store: postgres({
      mode: "iam",
      host: "db.example.rds.amazonaws.com",
      database: "errtraq",
      user: "app_user",
      region: "us-east-1",
      resourceId: "db-ABC123",
    }),
    platform: awsLambda({
      vpcSubnetIds: variable("SUBNETS"),
      vpcSecurityGroupIds: variable("SECURITY_GROUPS"),
    }),
    variables: {
      SUBNETS: {
        type: "string[]",
        sensitive: false,
        default: ["subnet-12345678"],
      },
      SECURITY_GROUPS: {
        type: "string[]",
        sensitive: false,
        default: ["sg-12345678"],
      },
    },
  }),
  existing: variant(shared, {
    store: {
      ...shared.store,
      existing: {
        table_name: "existing-store",
        table_arn: "arn:aws:dynamodb:us-east-1:123456789012:table/existing",
        policies: { read: { primary: policy }, write: { primary: policy } },
      },
    },
    queue: {
      ...shared.queue,
      existing: {
        queues: {
          shared: {
            arn: "arn:aws:sqs:us-east-1:123456789012:existing",
            url: literal,
          },
        },
        policies: { produce: { shared: policy }, consume: { shared: policy } },
      },
    },
  }),
  "nothing-split": variant(shared, { platform: awsLambda({ split: [] }) }),
  "everything-split": variant(perTopic, {
    platform: awsLambda({ split: ["ingest", "api", "consumer", "cron"] }),
  }),
  disposable: variant(shared, { protection: "disposable" }),
  archive: variant(perTopic, {
    archive: {
      manifest: {
        id: "fixture-archive",
        kind: "archive",
        runtimes: ["node"],
        requires: [],
        configSchema: z.strictObject({}),
        capabilities: { rowDelete: "copy-on-write" },
      },
      config: {},
      runtimeModule: "fixture-archive",
      infra: {
        module: {
          provider: "aws",
          component: "archive",
          outputs: {
            id: "string",
            policies: { map: { map: "json-document" } },
          },
        },
        inputs: () => ({}),
        resources: { primary: out("id") },
        capabilities: Object.fromEntries(
          ["read", "write", "delete"].map((capability) => [
            capability,
            { primary: out("policies", capability, "primary") },
          ]),
        ),
        bindings: [
          {
            name: "ARCHIVE_ID",
            kind: "env",
            purpose: "primary",
            value: out("id"),
          },
        ],
      },
      existing: {
        id: "existing-archive",
        policies: Object.fromEntries(
          ["read", "write", "delete"].map((capability) => [
            capability,
            { primary: policy },
          ]),
        ),
      },
    },
  }),
  variables: variant(shared, {
    variables: {
      SECRET: { type: "string", sensitive: true },
      DOCUMENT: {
        type: "json",
        sensitive: false,
        default: { app: "json-value" },
      },
    },
    store: {
      ...shared.store,
      infra: {
        ...shared.store.infra,
        inputs: (config, deployment) => ({
          ...shared.store.infra.inputs(config, deployment),
          tags: variable("DOCUMENT"),
        }),
      },
    },
    platform: {
      ...shared.platform,
      infra: {
        ...shared.platform.infra,
        module: {
          ...shared.platform.infra.module,
          sensitiveInputs: ["handler"],
        },
        inputs: (config, deployment) => ({
          ...shared.platform.infra.inputs(config, deployment),
          handler: variable("SECRET"),
        }),
      },
    },
  }),
};

// Expose actual resources from the copied, otherwise unchanged module to the root test.
const probe = `
output "test_vpc" { value = { for id, fn in aws_lambda_function.function : id => { subnet_ids = try(tolist(fn.vpc_config[0].subnet_ids), []), security_group_ids = try(tolist(fn.vpc_config[0].security_group_ids), []) } } }
output "test_vpc_policies" { value = { for id, policy in aws_iam_role_policy.vpc : id => policy.policy if policy.role == aws_iam_role.function[id].id } }
output "test_env" { value = { for id, fn in aws_lambda_function.function : id => fn.environment[0].variables } }
output "test_policies" {
  value = { for id, fn in var.functions : id => [for n, policy in fn.policies : aws_iam_role_policy.capability["\${id}-\${n}"].policy if aws_iam_role_policy.capability["\${id}-\${n}"].role == aws_iam_role.function[id].id] }
}
output "test_queues" {
  value = { for key, mapping in aws_lambda_event_source_mapping.queue : key => { resource = mapping.event_source_arn, function_id = one([for id, fn in aws_lambda_function.function : id if fn.arn == mapping.function_name]) } }
}
output "test_crons" {
  value = { for key, target in aws_cloudwatch_event_target.cron : key => one([for id, fn in aws_lambda_function.function : id if fn.arn == target.arn]) }
}
output "test_cron_rules" { value = { for key, rule in aws_cloudwatch_event_rule.cron : key => rule.schedule_expression } }
output "test_http" {
  value = { for role in ["ingest", "api"] : role => local.role_urls[role] if local.role_urls[role] != "" }
}
`;
const test = `mock_provider "aws" {
  mock_data "aws_iam_policy_document" { defaults = { json = "{}" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::123456789012:role/test" } }
  mock_resource "aws_sqs_queue" { defaults = { arn = "arn:aws:sqs:us-east-1:123456789012:test" } }
  mock_resource "aws_cloudwatch_event_rule" { defaults = { arn = "arn:aws:events:us-east-1:123456789012:rule/test" } }
}
run "generated_root" {
  command = apply
  assert {
    condition = jsonencode(module.platform.test_env) == jsonencode(output.expected_env)
    error_message = "Function environment differs from deployment view."
  }
  assert {
    condition = jsonencode(module.platform.test_policies) == jsonencode(output.expected_policies)
    error_message = "Function policies differ from deployment view."
  }
  assert {
    condition = jsonencode(module.platform.test_queues) == jsonencode(output.expected_queues)
    error_message = "Queue triggers differ from deployment view."
  }
  assert {
    condition = jsonencode(module.platform.test_crons) == jsonencode(output.expected_crons)
    error_message = "Cron triggers differ from deployment view."
  }
  assert {
    condition = jsonencode(module.platform.test_cron_rules) == jsonencode(output.expected_cron_schedules)
    error_message = "Cron rules differ from deployment view."
  }
  assert {
    condition = sort(keys(module.platform.test_http)) == sort(keys(output.expected_http))
    error_message = "HTTP roles differ from deployment view."
  }
  assert {
    condition = output.ingest_url == lookup(module.platform.test_http, "ingest", "") && output.api_url == lookup(module.platform.test_http, "api", "")
    error_message = "Stack HTTP outputs differ from the exposed function URLs."
  }
}
`;

export function prepareRoot(parent, name, version) {
  const stack = fixtures[name];
  if (!stack) throw new Error(`Unknown generated root fixture ${name}`);
  const target = resolve(parent, name);
  const modules = resolve(parent, `modules-${name}`);
  mkdirSync(target, { recursive: true });
  cpSync(resolve("infra/modules"), modules, { recursive: true });
  writeFileSync(resolve(modules, "aws/lambda-app/probe.tf"), probe);
  const view = deriveDeployment(stack);
  const options = {
    outputDirectory: target,
    modulesDirectory: modules,
    generationEnv: {},
    artifactPaths: Object.fromEntries(
      view.functions.map((fn) => [fn.id, `build/${fn.id}.zip`]),
    ),
  };
  const generated = generate(stack, options);
  if (generated.kind !== "terraform") throw new Error(generated.reason);
  if (
    name === "variables" &&
    (!generated.files["main.tf.json"].includes("$" + "{var.SECRET}") ||
      !generated.files["main.tf.json"].includes("jsondecode(var.DOCUMENT)"))
  )
    throw new Error("Variable fixture did not use both declared variables");
  for (const [file, content] of Object.entries(generated.files))
    writeFileSync(resolve(target, file), content);
  mkdirSync(resolve(target, "build"));
  for (const fn of view.functions)
    writeFileSync(resolve(target, `build/${fn.id}.zip`), "test artifact");
  const providerPath = resolve(target, "providers.tf.json");
  const provider = JSON.parse(readFileSync(providerPath, "utf8"));
  provider.terraform.required_providers.aws.version = `= ${version}`;
  writeFileSync(providerPath, `${JSON.stringify(provider, null, 2)}\n`);
  const render = (value, owner) =>
    renderInfraValue(value, owner, stack, options);
  const env = Object.fromEntries(
    view.functions.map((fn) => [
      fn.id,
      Object.fromEntries(
        [...fn.envBindings, ...fn.secretBindings].map((b) => [
          b.binding.name,
          render(b.binding.value, b.selection),
        ]),
      ),
    ]),
  );
  const policies = Object.fromEntries(
    view.functions.map((fn) => [
      fn.id,
      fn.policies.flatMap((p) =>
        p.policyOutput ? [render(p.policyOutput, p.selection)] : [],
      ),
    ]),
  );
  const queues = Object.fromEntries(
    view.triggers
      .filter((t) => t.kind === "queue")
      .map((t) => [
        t.physical,
        { resource: render(t.resource, "queue"), function_id: t.functionId },
      ]),
  );
  const crons = Object.fromEntries(
    view.triggers
      .filter((t) => t.kind === "cron")
      .map((t) => [t.name, t.functionId]),
  );
  const cron_schedules = Object.fromEntries(
    view.triggers
      .filter((t) => t.kind === "cron")
      .map((t) => {
        const [minute, hour, day, month] = t.schedule.split(" ");
        return [
          t.name,
          `cron(${minute} ${hour} ${day === "*" ? "?" : day} ${month} ${day === "*" ? "*" : "?"} *)`,
        ];
      }),
  );
  const http = Object.fromEntries(
    view.functions.flatMap((fn) => fn.http.map((role) => [role, true])),
  );
  const expectations = Object.fromEntries(
    Object.entries({ env, policies, queues, crons, cron_schedules, http }).map(
      ([key, value]) => [`expected_${key}`, { value }],
    ),
  );
  writeFileSync(
    resolve(target, "expectations.tf.json"),
    `${JSON.stringify({ output: expectations }, null, 2)}\n`,
  );
  mkdirSync(resolve(target, "tests"));
  const functionOverrides = view.functions
    .map(
      (fn) => `override_resource {
  target = module.platform.aws_lambda_function.function[${JSON.stringify(fn.id)}]
  values = { arn = "arn:aws:lambda:us-east-1:123456789012:function:${fn.id}" }
}`,
    )
    .join("\n");
  const queueOverrides = stack.queue.existing
    ? ""
    : view.triggers
        .filter((trigger) => trigger.kind === "queue")
        .map(
          (trigger) => `override_resource {
  target = module.queue.aws_sqs_queue.queue[${JSON.stringify(trigger.physical)}]
  values = { arn = "arn:aws:sqs:us-east-1:123456789012:${trigger.physical}", url = "https://sqs.example.test/${trigger.physical}" }
}`,
        )
        .join("\n");
  const vpcAssertions =
    name === "postgres-vpc"
      ? `
  assert {
    condition = alltrue([for fn in values(module.platform.test_vpc) : toset(fn.subnet_ids) == toset(var.SUBNETS) && toset(fn.security_group_ids) == toset(var.SECURITY_GROUPS)]) && length(module.platform.test_vpc_policies) == ${view.functions.length}
    error_message = "Every Lambda function must receive the requested VPC and network-interface policy."
  }
  assert {
    condition = jsondecode(module.store.policies.read.primary).Statement[0].Resource[0] == "arn:aws:rds-db:us-east-1:123456789012:dbuser:db-ABC123/app_user" && toset(jsondecode(module.store.policies.read.primary).Statement[0].Action) == toset(["rds-db:connect"])
    error_message = "Postgres IAM policy must identify the exact database and user."
  }
`
      : "";
  const rootTest = test.replace(/\n}\s*$/, `${vpcAssertions}\n}\n`);
  writeFileSync(
    resolve(target, "tests/root.tftest.hcl"),
    `${functionOverrides}\n${queueOverrides}\n${rootTest}`,
  );
  return target;
}
