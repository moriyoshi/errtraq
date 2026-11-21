import { assert, check, client, element, unique } from "./client.mjs";

/** Inventory representative control-plane operations, independently of adapter probes. */
export async function probeControl(endpoint) {
  const c = client(endpoint),
    results = {},
    name = unique();
  const json = (service, target, body) =>
    c.request(service, "/", {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": target,
      },
      body: JSON.stringify(body),
    });
  const query = (service, action, values = {}) =>
    c.request(service, "/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Action: action,
        Version: service === "sts" ? "2011-06-15" : "2010-05-08",
        ...values,
      }).toString(),
    });
  let roleCreated = false,
    fnCreated = false,
    urlCreated = false,
    mappingId,
    roleArn,
    logCreated = false,
    ruleCreated = false,
    queue;
  try {
    await check(results, "sts-get-caller-identity", async () => {
      const r = await query("sts", "GetCallerIdentity");
      assert.match(r.text, /<Account>/);
    });
    await check(results, "iam-role-create-read", async () => {
      const r = await query("iam", "CreateRole", {
        RoleName: name,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [],
        }),
      });
      roleCreated = true;
      roleArn = element(r.text, "Arn");
      assert.ok(roleArn);
      await query("iam", "GetRole", { RoleName: name });
    });
    await check(results, "lambda-function-create-read", async () => {
      assert.ok(roleArn, "IAM role creation prerequisite failed");
      await c.request("lambda", "/2015-03-31/functions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          FunctionName: name,
          Runtime: "nodejs22.x",
          Role: roleArn,
          Handler: "index.handler",
          Code: { ZipFile: "UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==" },
        }),
      });
      fnCreated = true;
      await c.request("lambda", `/2015-03-31/functions/${name}`);
    });
    await check(results, "lambda-function-url-create-read", async () => {
      assert.ok(fnCreated, "function creation prerequisite failed");
      await c.request("lambda", `/2021-10-31/functions/${name}/url`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ AuthType: "AWS_IAM" }),
      });
      urlCreated = true;
      await c.request("lambda", `/2021-10-31/functions/${name}/url`);
    });
    await check(
      results,
      "lambda-event-source-mapping-create-read",
      async () => {
        assert.ok(fnCreated, "function creation prerequisite failed");
        queue = (await c.sqs("CreateQueue", { QueueName: name })).QueueUrl;
        const attrs = await c.sqs("GetQueueAttributes", {
          QueueUrl: queue,
          AttributeNames: ["QueueArn"],
        });
        const r = await c.request(
          "lambda",
          "/2015-03-31/event-source-mappings/",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              FunctionName: name,
              EventSourceArn: attrs.Attributes.QueueArn,
              BatchSize: 10,
              Enabled: true,
            }),
          },
        );
        mappingId = JSON.parse(r.text).UUID;
        assert.ok(mappingId);
        await c.request(
          "lambda",
          `/2015-03-31/event-source-mappings/${mappingId}`,
        );
      },
    );
    await check(results, "cloudwatch-log-group-create-read", async () => {
      await json("logs", "Logs_20140328.CreateLogGroup", {
        logGroupName: `/aws/lambda/${name}`,
      });
      logCreated = true;
      const r = await json("logs", "Logs_20140328.DescribeLogGroups", {
        logGroupNamePrefix: `/aws/lambda/${name}`,
      });
      assert.match(r.text, new RegExp(name));
    });
    await check(results, "eventbridge-rule-create-read", async () => {
      await json("events", "AWSEvents.PutRule", {
        Name: name,
        ScheduleExpression: "rate(5 minutes)",
        State: "ENABLED",
      });
      ruleCreated = true;
      await json("events", "AWSEvents.DescribeRule", { Name: name });
    });
  } finally {
    if (mappingId)
      await check(results, "lambda-event-source-mapping-delete", async () => {
        await c.request(
          "lambda",
          `/2015-03-31/event-source-mappings/${mappingId}`,
          { method: "DELETE" },
        );
        await assert.rejects(() =>
          c.request("lambda", `/2015-03-31/event-source-mappings/${mappingId}`),
        );
      });
    if (queue) await c.sqs("DeleteQueue", { QueueUrl: queue }).catch(() => {});
    if (urlCreated)
      await check(results, "lambda-function-url-delete", async () => {
        await c.request("lambda", `/2021-10-31/functions/${name}/url`, {
          method: "DELETE",
        });
        await assert.rejects(() =>
          c.request("lambda", `/2021-10-31/functions/${name}/url`),
        );
      });
    if (fnCreated)
      await check(results, "lambda-function-delete", async () => {
        await c.request("lambda", `/2015-03-31/functions/${name}`, {
          method: "DELETE",
        });
        await assert.rejects(() =>
          c.request("lambda", `/2015-03-31/functions/${name}`),
        );
      });
    if (roleCreated)
      await check(results, "iam-role-delete", async () => {
        await query("iam", "DeleteRole", { RoleName: name });
        await assert.rejects(() => query("iam", "GetRole", { RoleName: name }));
      });
    if (logCreated)
      await check(results, "cloudwatch-log-group-delete", async () => {
        await json("logs", "Logs_20140328.DeleteLogGroup", {
          logGroupName: `/aws/lambda/${name}`,
        });
        const r = await json("logs", "Logs_20140328.DescribeLogGroups", {
          logGroupNamePrefix: `/aws/lambda/${name}`,
        });
        assert.doesNotMatch(r.text, new RegExp(name));
      });
    if (ruleCreated)
      await check(results, "eventbridge-rule-delete", async () => {
        await json("events", "AWSEvents.DeleteRule", { Name: name });
        await assert.rejects(() =>
          json("events", "AWSEvents.DescribeRule", { Name: name }),
        );
      });
  }
  return results;
}
