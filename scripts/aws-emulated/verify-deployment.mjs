import assert from "node:assert/strict";
import { element } from "./client.mjs";
import { canonicalPolicy, capabilityPolicy } from "./expected.mjs";

const sorted = (values) => [...values].sort();
async function iam(c, action, values = {}) {
  return (
    await c.request("iam", "/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Action: action,
        Version: "2010-05-08",
        ...values,
      }).toString(),
    })
  ).text;
}
async function json(c, service, target, body) {
  return JSON.parse(
    (
      await c.request(service, "/", {
        method: "POST",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": target,
        },
        body: JSON.stringify(body),
      })
    ).text,
  );
}
export async function verifyDeployment(c, stack, view, account) {
  const name = stack.name;
  const resources = { queues: {} };
  for (const purpose of ["store", "kv"]) {
    const tableName = `${name}-${purpose}`;
    const table = (await c.dynamo("DescribeTable", { TableName: tableName }))
      .Table;
    assert.equal(table.TableName, tableName);
    assert.equal(table.BillingModeSummary.BillingMode, "PAY_PER_REQUEST");
    assert.deepEqual(
      sorted(
        (table.GlobalSecondaryIndexes ?? []).map((index) => index.IndexName),
      ),
      purpose === "store"
        ? Array.from({ length: 8 }, (_, i) => `gsi${i + 1}`)
        : [],
    );
    for (const index of table.GlobalSecondaryIndexes ?? []) {
      const n = index.IndexName.slice(3);
      assert.deepEqual(index.KeySchema, [
        { AttributeName: `GSI${n}PK`, KeyType: "HASH" },
        { AttributeName: `GSI${n}SK`, KeyType: "RANGE" },
      ]);
      assert.equal(index.Projection.ProjectionType, "ALL");
    }
    const ttl = await c.dynamo("DescribeTimeToLive", { TableName: tableName });
    assert.equal(ttl.TimeToLiveDescription.AttributeName, "expiresAt");
    assert.equal(ttl.TimeToLiveDescription.TimeToLiveStatus, "ENABLED");
    const pitr = await c.dynamo("DescribeContinuousBackups", {
      TableName: tableName,
    });
    assert.equal(
      pitr.ContinuousBackupsDescription.PointInTimeRecoveryDescription
        .PointInTimeRecoveryStatus,
      "ENABLED",
    );
    resources[purpose] = table.TableArn;
  }
  const bucketList = (await c.request("s3", "/")).text;
  const buckets = [...bucketList.matchAll(/<Name>([^<]+)<\/Name>/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith(`${name}-`));
  assert.equal(buckets.length, 1, "expected one namespace bucket");
  resources.blob = `arn:aws:s3:::${buckets[0]}`;
  const triggers = view.triggers.filter((trigger) => trigger.kind === "queue");
  for (const trigger of triggers) {
    const queueName = `${name}-${trigger.physical}`;
    const { QueueUrl } = await c.sqs("GetQueueUrl", { QueueName: queueName });
    const { Attributes } = await c.sqs("GetQueueAttributes", {
      QueueUrl,
      AttributeNames: ["All"],
    });
    const dlq = await c.sqs("GetQueueUrl", { QueueName: `${queueName}-dlq` });
    const dead = await c.sqs("GetQueueAttributes", {
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ["All"],
    });
    assert.equal(
      Attributes.VisibilityTimeout,
      String(trigger.settings.visibilityTimeoutSec),
    );
    assert.equal(Attributes.MessageRetentionPeriod, "345600");
    assert.equal(Attributes.MaximumMessageSize, "1048576");
    assert.equal(Attributes.SqsManagedSseEnabled, "true");
    assert.equal(dead.Attributes.MessageRetentionPeriod, "1209600");
    assert.deepEqual(JSON.parse(Attributes.RedrivePolicy), {
      deadLetterTargetArn: dead.Attributes.QueueArn,
      maxReceiveCount: trigger.settings.dlq.maxReceiveCount,
    });
    resources.queues[trigger.physical] = Attributes.QueueArn;
  }
  const queueListing = await c.sqs("ListQueues", {
    QueueNamePrefix: `${name}-`,
  });
  const expectedQueueNames = triggers.flatMap((trigger) => [
    `${name}-${trigger.physical}`,
    `${name}-${trigger.physical}-dlq`,
  ]);
  assert.deepEqual(
    sorted((queueListing.QueueUrls ?? []).map((url) => url.split("/").at(-1))),
    sorted(expectedQueueNames),
    "queue inventory mismatch",
  );
  const functionListing = JSON.parse(
    (await c.request("lambda", "/2015-03-31/functions/")).text,
  );
  assert.deepEqual(
    sorted(
      (functionListing.Functions ?? [])
        .map((fn) => fn.FunctionName)
        .filter((fn) => fn.startsWith(`${name}-`)),
    ),
    sorted(view.functions.map((fn) => `${name}-${fn.id}`)),
    "function inventory mismatch",
  );
  const roleListing = await iam(c, "ListRoles");
  assert.deepEqual(
    sorted(
      [...roleListing.matchAll(/<RoleName>([^<]+)<\/RoleName>/g)]
        .map((match) => match[1])
        .filter((role) => role.startsWith(`${name}-`)),
    ),
    sorted(view.functions.map((fn) => `${name}-${fn.id}`)),
    "role inventory mismatch",
  );
  const allMappings =
    JSON.parse(
      (await c.request("lambda", "/2015-03-31/event-source-mappings/")).text,
    ).EventSourceMappings ?? [];
  const mappingForStack = allMappings.filter((mapping) =>
    mapping.FunctionArn.includes(`:function:${name}-`),
  );
  assert.equal(mappingForStack.length, triggers.length);
  for (const trigger of triggers) {
    const mapping = mappingForStack.find(
      (item) => item.EventSourceArn === resources.queues[trigger.physical],
    );
    assert.ok(mapping, `missing event mapping for ${trigger.physical}`);
    assert.ok(
      mapping.FunctionArn.endsWith(`:function:${name}-${trigger.functionId}`),
    );
    assert.equal(mapping.BatchSize, trigger.settings.batchSize);
  }
  for (const fn of view.functions) {
    const functionName = `${name}-${fn.id}`;
    const data = JSON.parse(
      (await c.request("lambda", `/2015-03-31/functions/${functionName}`)).text,
    ).Configuration;
    assert.equal(data.Runtime, stack.platform.config.runtime);
    assert.equal(data.Handler, stack.platform.config.handler);
    assert.equal(data.MemorySize, fn.settings.memoryMb ?? 512);
    assert.equal(data.Timeout, fn.settings.timeoutSec ?? 30);
    assert.deepEqual(
      sorted(Object.keys(data.Environment?.Variables ?? {})),
      sorted(
        [...fn.envBindings, ...fn.secretBindings].map(
          (item) => item.binding.name,
        ),
      ),
    );
    const roleName = functionName;
    const listed = await iam(c, "ListRolePolicies", { RoleName: roleName });
    const policyNames = [...listed.matchAll(/<member>([^<]+)<\/member>/g)].map(
      (match) => match[1],
    );
    const expectedNames = [
      "logs",
      ...fn.policies
        .filter((item) => item.policyOutput)
        .map((_, index) => `capability-${fn.id}-${index}`),
    ];
    assert.deepEqual(sorted(policyNames), sorted(expectedNames));
    const logArn = `arn:aws:logs:us-east-1:${account}:log-group:/aws/lambda/${functionName}:*`;
    const expected = [
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: logArn,
          },
        ],
      },
      ...fn.policies
        .filter((item) => item.policyOutput)
        .map((grant) =>
          grant.selection === "archive" && stack.archive?.existing
            ? JSON.parse(
                stack.archive.existing.policies[grant.capability][
                  grant.purpose
                ],
              )
            : capabilityPolicy(grant, resources),
        ),
    ];
    for (const [index, policyName] of expectedNames.entries()) {
      const response = await iam(c, "GetRolePolicy", {
        RoleName: roleName,
        PolicyName: policyName,
      });
      const text = element(response, "PolicyDocument");
      assert.ok(text, `missing IAM policy ${roleName}/${policyName}`);
      let document;
      try {
        document = JSON.parse(text);
      } catch {
        document = JSON.parse(decodeURIComponent(text));
      }
      assert.deepEqual(
        canonicalPolicy(document),
        canonicalPolicy(expected[index]),
        `incorrect IAM policy ${roleName}/${policyName}`,
      );
    }
    const logs = await json(c, "logs", "Logs_20140328.DescribeLogGroups", {
      logGroupNamePrefix: `/aws/lambda/${functionName}`,
    });
    assert.ok(
      logs.logGroups.some(
        (group) => group.logGroupName === `/aws/lambda/${functionName}`,
      ),
    );
  }
  const cron = view.triggers.filter((trigger) => trigger.kind === "cron");
  const listedRules = await json(c, "events", "AWSEvents.ListRules", {
    NamePrefix: `${name}-`,
  });
  assert.deepEqual(
    sorted((listedRules.Rules ?? []).map((rule) => rule.Name)),
    sorted(cron.map((trigger) => `${name}-${trigger.name}`)),
    "cron rule inventory mismatch",
  );
  for (const trigger of cron) {
    const targets = await json(c, "events", "AWSEvents.ListTargetsByRule", {
      Rule: `${name}-${trigger.name}`,
    });
    assert.equal(targets.Targets.length, 1);
    assert.ok(
      targets.Targets[0].Arn.endsWith(
        `:function:${name}-${trigger.functionId}`,
      ),
    );
    assert.deepEqual(JSON.parse(targets.Targets[0].Input), {
      job: trigger.name,
    });
  }
  return { resources, mappingForStack };
}

/** Inspect service inventories after destroy; no Terraform state is consulted. */
export async function verifyCleanup(c, name) {
  const tables = await c.dynamo("ListTables", {});
  assert.deepEqual(
    (tables.TableNames ?? []).filter((item) => item.startsWith(`${name}-`)),
    [],
    "tables remain after destroy",
  );
  const queues = await c.sqs("ListQueues", { QueueNamePrefix: `${name}-` });
  assert.deepEqual(
    (queues.QueueUrls ?? []).filter((url) =>
      url.split("/").at(-1)?.startsWith(`${name}-`),
    ),
    [],
    "queues remain after destroy",
  );
  const buckets = (await c.request("s3", "/")).text;
  assert.deepEqual(
    [...buckets.matchAll(/<Name>([^<]+)<\/Name>/g)]
      .map((m) => m[1])
      .filter((item) => item.startsWith(`${name}-`)),
    [],
    "buckets remain after destroy",
  );
  const roles = await iam(c, "ListRoles");
  assert.deepEqual(
    [...roles.matchAll(/<RoleName>([^<]+)<\/RoleName>/g)]
      .map((m) => m[1])
      .filter((item) => item.startsWith(`${name}-`)),
    [],
    "roles remain after destroy",
  );
  const functions = JSON.parse(
    (await c.request("lambda", "/2015-03-31/functions/")).text,
  );
  assert.deepEqual(
    (functions.Functions ?? []).filter((item) =>
      item.FunctionName.startsWith(`${name}-`),
    ),
    [],
    "functions remain after destroy",
  );
  const mappings = JSON.parse(
    (await c.request("lambda", "/2015-03-31/event-source-mappings/")).text,
  );
  assert.deepEqual(
    (mappings.EventSourceMappings ?? []).filter((item) =>
      item.FunctionArn.includes(`:function:${name}-`),
    ),
    [],
    "mappings remain after destroy",
  );
  const logs = await json(c, "logs", "Logs_20140328.DescribeLogGroups", {
    logGroupNamePrefix: `/aws/lambda/${name}-`,
  });
  assert.deepEqual(
    (logs.logGroups ?? []).filter((group) =>
      group.logGroupName.startsWith(`/aws/lambda/${name}-`),
    ),
    [],
    "log groups remain after destroy",
  );
  const rules = await json(c, "events", "AWSEvents.ListRules", {
    NamePrefix: `${name}-`,
  });
  assert.deepEqual(
    (rules.Rules ?? []).filter((rule) => rule.Name.startsWith(`${name}-`)),
    [],
    "EventBridge rules remain after destroy",
  );
}
