import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { sqsQueue } from "../packages/adapters/queue-sqs/dist/stack.js";
import { postgres } from "../packages/adapters/store-sql/dist/postgres-stack.js";
import {
  configReference,
  deriveDeployment,
  env,
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
  "grouped-shared": variant(shared, {
    recordMode: "grouped",
    platform: awsLambda({
      roles: ["ingest", "api", "consumer", "record", "cron"],
      split: ["ingest", "api", "consumer", "record", "cron"],
    }),
  }),
  "grouped-per-topic": variant(perTopic, {
    recordMode: "grouped",
    platform: awsLambda({
      roles: ["ingest", "api", "consumer", "record", "cron"],
      split: ["ingest", "api", "consumer", "record", "cron"],
    }),
  }),
  "rate-direct-issue": variant(shared, {
    recordMode: "direct",
    platform: awsLambda({
      roles: ["ingest", "api", "consumer", "cron"],
      split: ["ingest", "api", "consumer", "cron"],
    }),
    rateRejection: { issueRateLimit: { events: 2, windowSec: 60 } },
  }),
  "rate-direct-new": variant(shared, {
    recordMode: "direct",
    platform: awsLambda({
      roles: ["ingest", "api", "consumer", "cron"],
      split: ["ingest", "api", "consumer", "cron"],
    }),
    rateRejection: { newIssueCap: { issues: 2, windowSec: 60 } },
  }),
  "rate-grouped-issue": variant(shared, {
    recordMode: "grouped",
    platform: awsLambda({
      roles: ["ingest", "api", "consumer", "record", "cron"],
      split: ["ingest", "api", "consumer", "record", "cron"],
    }),
    rateRejection: { issueRateLimit: { events: 2, windowSec: 60 } },
  }),
  "rate-grouped-new": variant(shared, {
    recordMode: "grouped",
    platform: awsLambda({
      roles: ["ingest", "api", "consumer", "record", "cron"],
      split: ["ingest", "api", "consumer", "record", "cron"],
    }),
    rateRejection: { newIssueCap: { issues: 2, windowSec: 60 } },
  }),
  "artifact-s3": variant(shared, {
    recordMode: "direct",
    platform: awsLambda({ artifactBucket: "deployment-artifacts-123" }),
  }),
  "alarm-topic": variant(shared, {
    recordMode: "grouped",
    platform: awsLambda({
      roles: ["ingest", "api", "consumer", "record", "cron"],
      split: ["ingest", "api", "consumer", "record", "cron"],
      alarmTopicArn: "arn:aws:sns:us-east-1:123456789012:operators",
    }),
    queue: sqsQueue({
      mode: "per-topic",
      alarmTopicArn: "arn:aws:sns:us-east-1:123456789012:operators",
    }),
  }),
  "config-refs": variant(shared, {
    store: {
      ...shared.store,
      manifest: {
        ...shared.store.manifest,
        configSchema: z.strictObject({
          path: configReference(z.string()),
          list: configReference(z.array(z.string())),
          document: configReference(z.unknown()),
          enabled: configReference(z.boolean()),
          count: configReference(z.number()),
        }),
      },
      config: {
        path: env("STORE_PATH", { defaultValue: "/data" }),
        list: variable("LIST"),
        document: variable("DOCUMENT"),
        enabled: variable("ENABLED"),
        count: variable("COUNT"),
      },
    },
    variables: {
      LIST: { type: "string[]", sensitive: false, default: ["a", "b"] },
      DOCUMENT: { type: "json", sensitive: false, default: { key: "value" } },
      ENABLED: { type: "bool", sensitive: false, default: true },
      COUNT: { type: "number", sensitive: false, default: 5 },
    },
  }),
  "postgres-secret": variant(shared, {
    store: postgres(variable("POSTGRES_SECRET_ARN")),
    variables: {
      POSTGRES_SECRET_ARN: {
        type: "string",
        sensitive: false,
        default:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:postgres-ABC123",
      },
    },
  }),
  "postgres-vpc": variant(shared, {
    recordMode: "direct",
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
    recordMode: "direct",
    platform: awsLambda(),
    store: {
      ...shared.store,
      existing: {
        table_name: "existing-store",
        table_arn: "arn:aws:dynamodb:us-east-1:123456789012:table/existing",
        policies: {
          read: { primary: policy },
          "key-read": { primary: policy },
          write: { primary: policy },
          "metadata-delete": { primary: policy },
        },
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
  "nothing-split": variant(shared, {
    recordMode: "direct",
    platform: awsLambda({ split: [] }),
  }),
  "everything-split": variant(perTopic, {
    recordMode: "direct",
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
output "test_artifacts" { value = { for id, fn in aws_lambda_function.function : id => { filename = fn.filename, s3_bucket = fn.s3_bucket, s3_key = fn.s3_key } } }
output "test_env" { value = { for id, fn in aws_lambda_function.function : id => fn.environment[0].variables } }
output "test_secret_reads" { value = { for id in keys(var.functions) : id => try(jsondecode(aws_iam_role_policy.secret_reads[id].policy).Statement[0].Resource, []) } }
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
output "test_alarms" {
  value = { for id, alarm in aws_cloudwatch_metric_alarm.errors : id => { name = alarm.alarm_name, namespace = alarm.namespace, metric = alarm.metric_name, dimensions = alarm.dimensions, statistic = alarm.statistic, period = alarm.period, evaluation_periods = alarm.evaluation_periods, datapoints_to_alarm = alarm.datapoints_to_alarm, threshold = alarm.threshold, comparison = alarm.comparison_operator, missing = alarm.treat_missing_data, actions = tolist(alarm.alarm_actions), tags = alarm.tags } }
}
output "test_http" {
  value = { for role in ["ingest", "api"] : role => local.role_urls[role] if local.role_urls[role] != "" }
}
`;
const queueProbe = `
locals {
  test_alarm_fields = { for key, alarm in merge({ for k, a in aws_cloudwatch_metric_alarm.dlq_messages : "dlq|\${k}" => a }, { for k, a in aws_cloudwatch_metric_alarm.queue_age : "age|\${k}" => a }) : key => { name = alarm.alarm_name, namespace = alarm.namespace, metric = alarm.metric_name, dimensions = alarm.dimensions, statistic = alarm.statistic, period = alarm.period, evaluation_periods = alarm.evaluation_periods, datapoints_to_alarm = alarm.datapoints_to_alarm, threshold = alarm.threshold, comparison = alarm.comparison_operator, missing = alarm.treat_missing_data, actions = tolist(alarm.alarm_actions), tags = alarm.tags } }
}
output "test_alarms" { value = local.test_alarm_fields }
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
    condition = jsonencode(module.platform.test_secret_reads) == jsonencode(output.expected_secret_reads)
    error_message = "Secret-read policy resources differ from the deployment view."
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
    condition = jsonencode(module.platform.test_alarms) == jsonencode(output.expected_function_alarms)
    error_message = "Function alarms differ from the deployment view."
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
  writeFileSync(resolve(modules, "aws/sqs/probe.tf"), queueProbe);
  const view = deriveDeployment(stack);
  // Independent access matrix: root tests below compare actual module env and policies
  // against this derived view, while these assertions constrain the view itself.
  if (name.startsWith("rate-") || name === "grouped-shared") {
    const expected =
      name === "rate-direct-issue" ||
      name === "rate-direct-new" ||
      name === "rate-grouped-issue"
        ? ["consumer"]
        : name === "rate-grouped-new"
          ? ["record"]
          : [];
    for (const role of ["api", "consumer", "record"]) {
      const fn = view.functions.find((item) => item.roles.includes(role));
      if (!fn) continue;
      const wanted =
        role === "api" ? name.startsWith("rate-") : expected.includes(role);
      const grants = fn.policies
        .filter((item) => item.selection === "kv")
        .map((item) => item.capability)
        .sort();
      const binding = fn.envBindings.some(
        (item) =>
          item.selection === "kv" && item.binding.name === "ERRTRAQ_KV_TABLE",
      );
      if (
        JSON.stringify(grants) !==
          JSON.stringify(
            wanted ? (role === "api" ? ["read"] : ["read", "write"]) : [],
          ) ||
        binding !== wanted
      )
        throw new Error(`Incorrect ${role} KV scope in ${name}`);
    }
  }
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
  const secret_reads = Object.fromEntries(
    view.functions.map((fn) => [
      fn.id,
      fn.secretReads.map((item) => render(item.identifier, item.selection)),
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
  const tags = stack.providers.aws.tags;
  const alarm = (fields) => ({
    statistic: "Maximum",
    period: 300,
    evaluation_periods: 1,
    datapoints_to_alarm: 1,
    threshold: 0,
    comparison: "GreaterThanThreshold",
    missing: "notBreaching",
    tags,
    ...fields,
  });
  const functionTopic = stack.platform.config.alarmTopicArn;
  const function_alarms = Object.fromEntries(
    view.functions.map((fn) => [
      fn.id,
      alarm({
        name: `${stack.name}-${fn.id}-errors`,
        namespace: "AWS/Lambda",
        metric: "Errors",
        dimensions: { FunctionName: `${stack.name}-${fn.id}` },
        statistic: "Sum",
        actions: functionTopic ? [functionTopic] : [],
      }),
    ]),
  );
  // Only queues the stack owns have alarms; an existing queue is the operator's.
  const queueTopic = stack.queue.config?.alarmTopicArn;
  const queue_alarms = {};
  if (!stack.queue.existing) {
    const fifo = (physical) => (physical === "record" ? ".fifo" : "");
    const seen = new Set();
    for (const trigger of view.triggers) {
      if (trigger.kind !== "queue" || seen.has(trigger.physical)) continue;
      seen.add(trigger.physical);
      const queueName = `${stack.name}-${trigger.physical}${fifo(trigger.physical)}`;
      const actions = queueTopic ? [queueTopic] : [];
      queue_alarms[`age|${trigger.physical}`] = alarm({
        name: `${stack.name}-${trigger.physical}-queue-age`,
        namespace: "AWS/SQS",
        metric: "ApproximateAgeOfOldestMessage",
        dimensions: { QueueName: queueName },
        evaluation_periods: 3,
        datapoints_to_alarm: 3,
        threshold: 900,
        actions,
      });
      if (trigger.settings.dlq?.enabled)
        queue_alarms[`dlq|${trigger.physical}`] = alarm({
          name: `${stack.name}-${trigger.physical}-dlq-messages`,
          namespace: "AWS/SQS",
          metric: "ApproximateNumberOfMessagesVisible",
          dimensions: {
            QueueName: `${stack.name}-${trigger.physical}-dlq${fifo(trigger.physical)}`,
          },
          actions,
        });
    }
  }
  const expectations = Object.fromEntries(
    Object.entries({
      function_alarms,
      queue_alarms,
      env,
      policies,
      secret_reads,
      queues,
      crons,
      cron_schedules,
      http,
    }).map(([key, value]) => [`expected_${key}`, { value }]),
  );
  const api = view.functions.find((fn) => fn.roles.includes("api"));
  const metadata = api?.policies.find(
    (grant) =>
      grant.selection === "store" && grant.capability === "metadata-delete",
  );
  if (stack.store.manifest.id === "store-dynamodb") {
    if (!api || !metadata?.policyOutput)
      throw new Error("API metadata-delete grant is missing");
    expectations.expected_metadata_delete = {
      value: render(metadata.policyOutput, "store"),
    };
  }
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
  const queueAlarmAssertion = stack.queue.existing
    ? ""
    : `
  assert {
    condition = jsonencode(module.queue.test_alarms) == jsonencode(output.expected_queue_alarms)
    error_message = "Queue alarms differ from the deployment view."
  }
`;
  let metadataAssertion = "";
  if (stack.store.manifest.id === "store-dynamodb") {
    if (!api) throw new Error("API function is missing");
    metadataAssertion = `
  assert {
    condition = contains([for policy in module.platform.test_policies[${JSON.stringify(api.id)}] : jsonencode(jsondecode(policy))], jsonencode(jsondecode(output.expected_metadata_delete)))
    error_message = "The API function must receive the store metadata-delete policy."
  }
`;
  }
  const artifactAssertion =
    name === "artifact-s3"
      ? `
  assert {
    condition = alltrue([for id, fn in module.platform.test_artifacts : fn.filename == null && fn.s3_bucket == "deployment-artifacts-123" && fn.s3_key == "${stack.name}/\${id}/\${filesha256("build/\${id}.zip")}.zip"])
    error_message = "Every Lambda artifact must be uploaded to the configured bucket."
  }
`
      : "";
  const rootTest = test.replace(
    /\n}\s*$/,
    `${vpcAssertions}${metadataAssertion}${queueAlarmAssertion}${artifactAssertion}\n}\n`,
  );
  writeFileSync(
    resolve(target, "tests/root.tftest.hcl"),
    `${functionOverrides}\n${queueOverrides}\n${rootTest}`,
  );
  return target;
}
