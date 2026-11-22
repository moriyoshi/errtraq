import assert from "node:assert/strict";

/** Minimal XML reader for the flat CloudWatch query responses: elements to nested objects, `member` lists to arrays. */
export function parseXml(text) {
  const tokens = [
    ...text.matchAll(/<(\/?)([A-Za-z0-9]+)[^>]*?(\/?)>|([^<]+)/g),
  ];
  let index = 0;
  const decode = (value) =>
    value
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&");
  function node() {
    const children = [];
    let value = "";
    while (index < tokens.length) {
      const [, close, name, selfClose, data] = tokens[index++];
      if (data !== undefined) value += data;
      else if (close) break;
      else if (selfClose) children.push([name, ""]);
      else children.push([name, node()]);
    }
    if (!children.length) return decode(value.trim());
    if (children.every(([name]) => name === "member"))
      return children.map(([, child]) => child);
    return Object.fromEntries(children);
  }
  return node();
}

export async function monitoring(c, action, values = {}) {
  const { text } = await c.request("monitoring", "/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Action: action,
      Version: "2010-08-01",
      ...values,
    }).toString(),
  });
  return parseXml(text);
}

export async function describeAlarms(c, prefix) {
  const result = await monitoring(
    c,
    "DescribeAlarms",
    prefix ? { AlarmNamePrefix: prefix } : {},
  );
  const alarms =
    result.DescribeAlarmsResponse?.DescribeAlarmsResult?.MetricAlarms ?? [];
  return Array.isArray(alarms) ? alarms : [];
}

const alarm = (tags, fields) => ({
  Statistic: "Maximum",
  Period: "300",
  EvaluationPeriods: "1",
  DatapointsToAlarm: "1",
  Threshold: 0,
  ComparisonOperator: "GreaterThanThreshold",
  TreatMissingData: "notBreaching",
  ...fields,
  tags,
});

/** Expected alarms keyed by name, derived from the deployment view and the module contract. */
export function expectedAlarms(stack, view) {
  const expected = {};
  const functionTopic = stack.platform.config.alarmTopicArn;
  for (const fn of view.functions)
    expected[`${stack.name}-${fn.id}-errors`] = alarm(undefined, {
      Namespace: "AWS/Lambda",
      MetricName: "Errors",
      Dimensions: { FunctionName: `${stack.name}-${fn.id}` },
      Statistic: "Sum",
      AlarmActions: functionTopic ? [functionTopic] : [],
    });
  if (stack.queue.existing) return expected;
  const queueTopic = stack.queue.config?.alarmTopicArn;
  const seen = new Set();
  for (const trigger of view.triggers) {
    if (trigger.kind !== "queue" || seen.has(trigger.physical)) continue;
    seen.add(trigger.physical);
    const suffix = trigger.physical === "record" ? ".fifo" : "";
    const AlarmActions = queueTopic ? [queueTopic] : [];
    expected[`${stack.name}-${trigger.physical}-queue-age`] = alarm(undefined, {
      Namespace: "AWS/SQS",
      MetricName: "ApproximateAgeOfOldestMessage",
      Dimensions: { QueueName: `${stack.name}-${trigger.physical}${suffix}` },
      EvaluationPeriods: "3",
      DatapointsToAlarm: "3",
      Threshold: 900,
      AlarmActions,
    });
    if (trigger.settings.dlq?.enabled)
      expected[`${stack.name}-${trigger.physical}-dlq-messages`] = alarm(
        undefined,
        {
          Namespace: "AWS/SQS",
          MetricName: "ApproximateNumberOfMessagesVisible",
          Dimensions: {
            QueueName: `${stack.name}-${trigger.physical}-dlq${suffix}`,
          },
          AlarmActions,
        },
      );
  }
  return expected;
}

/**
 * Compare the emulator's alarm inventory with the contract. DatapointsToAlarm and TreatMissingData
 * are not returned by the pinned emulator (gap cloudwatch-alarm-readback), so the Terraform mock
 * tests assert them and the repeat plan proves the gap still reproduces.
 */
export async function verifyAlarms(c, stack, view) {
  const expected = expectedAlarms(stack, view);
  const actual = await describeAlarms(c, `${stack.name}-`);
  assert.deepEqual(
    actual.map((item) => item.AlarmName).sort(),
    Object.keys(expected).sort(),
    "CloudWatch alarm inventory mismatch",
  );
  for (const item of actual) {
    const want = expected[item.AlarmName];
    const dimensions = Object.fromEntries(
      (Array.isArray(item.Dimensions) ? item.Dimensions : []).map((entry) => [
        entry.Name,
        entry.Value,
      ]),
    );
    assert.equal(item.Namespace, want.Namespace, item.AlarmName);
    assert.equal(item.MetricName, want.MetricName, item.AlarmName);
    assert.deepEqual(dimensions, want.Dimensions, item.AlarmName);
    assert.equal(item.Statistic, want.Statistic, item.AlarmName);
    assert.equal(Number(item.Threshold), want.Threshold, item.AlarmName);
    assert.equal(item.ComparisonOperator, want.ComparisonOperator);
    assert.deepEqual(
      Array.isArray(item.AlarmActions) ? item.AlarmActions : [],
      want.AlarmActions,
      `${item.AlarmName} actions`,
    );
    assert.equal(item.ActionsEnabled, "true", item.AlarmName);
    for (const field of ["Period", "EvaluationPeriods"])
      assert.equal(
        String(item[field]),
        String(want[field]),
        `${item.AlarmName} ${field}`,
      );
  }
  return actual.length;
}
