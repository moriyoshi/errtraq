import { describe, expect, it } from "vitest";
import { expectedAlarms, parseXml } from "./cloudwatch.mjs";

describe("CloudWatch emulator helpers", () => {
  it("parses member lists and nested alarm fields", () => {
    const xml =
      '<DescribeAlarmsResponse xmlns="x"><DescribeAlarmsResult><MetricAlarms><member><AlarmName>a</AlarmName><AlarmActions><member>arn:one</member></AlarmActions><Dimensions><member><Name>QueueName</Name><Value>q.fifo</Value></member></Dimensions><OKActions></OKActions></member></MetricAlarms></DescribeAlarmsResult></DescribeAlarmsResponse>';
    const [alarm] =
      parseXml(xml).DescribeAlarmsResponse.DescribeAlarmsResult.MetricAlarms;
    expect(alarm.AlarmName).toBe("a");
    expect(alarm.AlarmActions).toEqual(["arn:one"]);
    expect(alarm.Dimensions).toEqual([{ Name: "QueueName", Value: "q.fifo" }]);
    expect(alarm.OKActions).toBe("");
  });
  it("derives one alarm per function, queue and enabled DLQ with FIFO names", () => {
    const stack = {
      name: "s",
      platform: { config: { alarmTopicArn: "arn:topic" } },
      queue: { config: {} },
    };
    const view = {
      functions: [{ id: "api" }],
      triggers: [
        {
          kind: "queue",
          physical: "shared",
          settings: { dlq: { enabled: false } },
        },
        {
          kind: "queue",
          physical: "record",
          settings: { dlq: { enabled: true } },
        },
        {
          kind: "queue",
          physical: "record",
          settings: { dlq: { enabled: true } },
        },
        { kind: "cron", name: "job" },
      ],
    };
    const alarms = expectedAlarms(stack, view);
    expect(Object.keys(alarms).sort()).toEqual([
      "s-api-errors",
      "s-record-dlq-messages",
      "s-record-queue-age",
      "s-shared-queue-age",
    ]);
    expect(alarms["s-record-dlq-messages"].Dimensions).toEqual({
      QueueName: "s-record-dlq.fifo",
    });
    expect(alarms["s-api-errors"].AlarmActions).toEqual(["arn:topic"]);
    expect(alarms["s-shared-queue-age"].AlarmActions).toEqual([]);
  });
});
