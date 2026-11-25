import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { element } from "./client.mjs";
import { canonicalPolicy } from "./expected.mjs";
import { assertPartialBatchSupport } from "./gap-checks.mjs";
import { skipped } from "./gaps.mjs";
import { assertRepeatPlan } from "./plan-check.mjs";
import { moduleShapes } from "./shapes.mjs";
import { providerOverride } from "./terraform-config.mjs";
import { verifyCleanup } from "./verify-deployment.mjs";

export async function runStandalone({
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
}) {
  for (const component of ["dynamodb", "sqs", "lambda-app"]) {
    const name = `m3a2-standalone-${component}`,
      dir = resolve(temp, name);
    mkdirSync(dir, { recursive: true });
    const common = { name, tags: {} };
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["sqs:ReceiveMessage"],
          Resource: [`arn:aws:sqs:us-east-1:${account}:${name}`],
        },
      ],
    });
    const inputs =
      component === "dynamodb"
        ? { ...common, purpose: "store", protection: "disposable" }
        : component === "sqs"
          ? {
              ...common,
              physical_queues: {
                shared: {
                  visibility_timeout_sec: 180,
                  dlq_enabled: true,
                  max_receive_count: 3,
                },
              },
            }
          : {
              ...common,
              functions: {
                all: {
                  roles: ["ingest", "consumer", "cron"],
                  http: ["ingest"],
                  artifact: "artifact.zip",
                  memory_mb: 256,
                  timeout_sec: 30,
                  architecture: "x86_64",
                  environment: { EXAMPLE: "value" },
                  secrets: {},
                  policies: [policy],
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
            };
    writeFileSync(
      resolve(dir, "main.tf.json"),
      JSON.stringify(
        {
          terraform: {
            required_providers: {
              aws: { source: "hashicorp/aws", version: `= ${version}` },
            },
          },
          provider: { aws: [{ region: "us-east-1" }] },
          module: {
            test: { source: resolve(modules, "aws", component), ...inputs },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      resolve(dir, "emulator_override.tf.json"),
      JSON.stringify(providerOverride(endpoint, version), null, 2),
    );
    writeFileSync(
      resolve(dir, "index.mjs"),
      "export const handler = async () => ({ statusCode: 200 });\n",
    );
    run("zip", ["-q", "artifact.zip", "index.mjs"], dir);
    tf(dir, "init", "-backend=false", "-input=false", `-plugin-dir=${cache}`);
    console.log(`Applying standalone ${component}`);
    tf(dir, "apply", "-auto-approve", "-input=false");
    if (component === "dynamodb") {
      const TableName = `${name}-store-v2`,
        table = (await c.dynamo("DescribeTable", { TableName })).Table;
      const shape = (await moduleShapes()).table;
      assert.equal(table.BillingModeSummary.BillingMode, "PAY_PER_REQUEST");
      assert.equal(table.SSEDescription?.Status, "ENABLED");
      assert.deepEqual(
        [...table.GlobalSecondaryIndexes]
          .sort((a, b) => a.IndexName.localeCompare(b.IndexName))
          .map((i) => ({
            IndexName: i.IndexName,
            KeySchema: i.KeySchema,
            Projection: i.Projection,
          })),
        [...shape.GlobalSecondaryIndexes].sort((a, b) =>
          a.IndexName.localeCompare(b.IndexName),
        ),
      );
      assert.equal(
        (await c.dynamo("DescribeTimeToLive", { TableName }))
          .TimeToLiveDescription.AttributeName,
        "ttlEpoch",
      );
      const metadata = await c.dynamo("GetItem", {
        TableName,
        Key: { PK: { S: "META|schema" }, SK: { S: "DATA" } },
        ConsistentRead: true,
      });
      assert.equal(metadata.Item.projectTimeShards.N, "4");
      assert.equal(
        (await c.dynamo("DescribeContinuousBackups", { TableName }))
          .ContinuousBackupsDescription.PointInTimeRecoveryDescription
          .PointInTimeRecoveryStatus,
        "ENABLED",
      );
    } else if (component === "sqs") {
      const main = await c.sqs("GetQueueUrl", { QueueName: `${name}-shared` });
      const dead = await c.sqs("GetQueueUrl", {
        QueueName: `${name}-shared-dlq`,
      });
      const attrs = (
        await c.sqs("GetQueueAttributes", {
          QueueUrl: main.QueueUrl,
          AttributeNames: ["All"],
        })
      ).Attributes;
      const deadAttrs = (
        await c.sqs("GetQueueAttributes", {
          QueueUrl: dead.QueueUrl,
          AttributeNames: ["All"],
        })
      ).Attributes;
      assert.equal(attrs.VisibilityTimeout, "180");
      assert.equal(attrs.MessageRetentionPeriod, "345600");
      assert.equal(attrs.MaximumMessageSize, "1048576");
      assert.equal(attrs.SqsManagedSseEnabled, "true");
      assert.equal(deadAttrs.MessageRetentionPeriod, "1209600");
      assert.deepEqual(JSON.parse(attrs.RedrivePolicy), {
        deadLetterTargetArn: deadAttrs.QueueArn,
        maxReceiveCount: 3,
      });
    } else {
      const functionName = `${name}-all`;
      const fn = JSON.parse(
        (await c.request("lambda", `/2015-03-31/functions/${functionName}`))
          .text,
      ).Configuration;
      assert.deepEqual(Object.keys(fn.Environment.Variables), ["EXAMPLE"]);
      assert.equal(fn.Runtime, "nodejs26.x");
      assert.equal(fn.Handler, "index.handler");
      assert.equal(fn.MemorySize, 256);
      assert.equal(fn.Timeout, 30);
      const iam = async (action, fields) =>
        (
          await c.request("iam", "/", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              Action: action,
              Version: "2010-05-08",
              ...fields,
            }).toString(),
          })
        ).text;
      const listed = await iam("ListRolePolicies", { RoleName: functionName });
      assert.deepEqual(
        [...listed.matchAll(/<member>([^<]+)<\/member>/g)]
          .map((m) => m[1])
          .sort(),
        ["capability-all-0", "logs"],
      );
      const stored = await iam("GetRolePolicy", {
        RoleName: functionName,
        PolicyName: "capability-all-0",
      });
      assert.deepEqual(
        canonicalPolicy(JSON.parse(element(stored, "PolicyDocument"))),
        canonicalPolicy(JSON.parse(policy)),
      );
      const logPolicy = await iam("GetRolePolicy", {
        RoleName: functionName,
        PolicyName: "logs",
      });
      const expectedLogPolicy = {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: `arn:aws:logs:us-east-1:${account}:log-group:/aws/lambda/${functionName}:*`,
          },
        ],
      };
      assert.deepEqual(
        canonicalPolicy(JSON.parse(element(logPolicy, "PolicyDocument"))),
        canonicalPolicy(expectedLogPolicy),
      );
      const logBody = JSON.parse(
        (
          await c.request("logs", "/", {
            method: "POST",
            headers: {
              "content-type": "application/x-amz-json-1.1",
              "x-amz-target": "Logs_20140328.DescribeLogGroups",
            },
            body: JSON.stringify({
              logGroupNamePrefix: `/aws/lambda/${functionName}`,
            }),
          })
        ).text,
      );
      assert.equal(
        logBody.logGroups.filter(
          (log) => log.logGroupName === `/aws/lambda/${functionName}`,
        ).length,
        1,
      );
      const mappings = JSON.parse(
        (await c.request("lambda", "/2015-03-31/event-source-mappings/")).text,
      ).EventSourceMappings;
      const mapping = mappings.find((item) =>
        item.FunctionArn.endsWith(`:function:${functionName}`),
      );
      assertPartialBatchSupport(mapping);
      const targets = JSON.parse(
        (
          await c.request("events", "/", {
            method: "POST",
            headers: {
              "content-type": "application/x-amz-json-1.1",
              "x-amz-target": "AWSEvents.ListTargetsByRule",
            },
            body: JSON.stringify({ Rule: `${name}-recovery` }),
          })
        ).text,
      );
      assert.deepEqual(targets.Targets[0].RetryPolicy, {
        MaximumEventAgeInSeconds: 86400,
        MaximumRetryAttempts: 185,
      });
      assert.equal(
        targets.Targets[0].DeadLetterConfig.Arn,
        `arn:aws:sqs:us-east-1:${account}:${name}`,
      );
    }
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
      run("terraform", ["show", "-no-color", "-json", "repeat.tfplan"], dir),
    );
    for (const id of assertRepeatPlan(repeat, gaps)) skipped(gaps, id);
    tf(dir, "apply", "-auto-approve", "-input=false");
    tf(dir, "destroy", "-auto-approve", "-input=false");
    await verifyCleanup(c, name);
    console.log(
      `PASS standalone ${component} apply, API assertions and destroy`,
    );
  }
}
