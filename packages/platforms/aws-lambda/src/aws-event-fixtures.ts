// Documentation-shaped AWS event fixtures. Only placeholder identifiers from the AWS
// documentation are used (account 123456789012, example ARNs, documentation IDs).
// Message bodies are errtraq's own queue envelopes, not the documentation's "Test message.".
// The builders were checked against scrubbed real captures taken in the third real AWS run
// (2026-11-25); the captures live in ./fixtures/captured/ (see its README.md) and
// aws-captures.test.ts asserts key-set and field-format parity between them and these builders.
import { createHash } from "node:crypto";

export const STANDARD_QUEUE_ARN = "arn:aws:sqs:us-east-2:123456789012:my-queue";
export const FIFO_QUEUE_ARN = "arn:aws:sqs:us-east-2:123456789012:fifo.fifo";

const md5 = (body: string) => createHash("md5").update(body).digest("hex");

/**
 * Standard queue record following "Example Amazon SQS message event (standard queue)":
 * https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#example-standard-queue-message-event
 * Fields, attribute names and value formats (string-typed counters, 13-digit millisecond
 * timestamps, empty messageAttributes) match the page; messageId and receiptHandle use the
 * page's values for the first record.
 */
export function sqsStandardRecord(
  body: string,
  changes: Record<string, unknown> = {},
) {
  return {
    messageId: "059f36b4-87a3-44ab-83d2-661975830a7d",
    receiptHandle: "AQEBwJnKyrHigUMZj6rYigCgxlaS3SLy0a...",
    body,
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "1545082649183",
      SenderId: "AIDAIENQZJOLO23YVJ4VO",
      ApproximateFirstReceiveTimestamp: "1545082649185",
    },
    messageAttributes: {
      myAttribute: {
        stringValue: "myValue",
        stringListValues: [],
        binaryListValues: [],
        dataType: "String",
      },
    },
    md5OfBody: md5(body),
    eventSource: "aws:sqs",
    eventSourceARN: STANDARD_QUEUE_ARN,
    awsRegion: "us-east-2",
    ...changes,
  };
}

/** The second documented standard record (empty messageAttributes). */
export function sqsStandardSecondRecord(body: string) {
  return sqsStandardRecord(body, {
    messageId: "2e1424d4-f796-459a-8184-9c92662be6da",
    receiptHandle: "AQEBzWwaftRI0KuVm4tP+/7q1rGgNqicHq...",
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "1545082650636",
      SenderId: "AIDAIENQZJOLO23YVJ4VO",
      ApproximateFirstReceiveTimestamp: "1545082650649",
    },
    messageAttributes: {},
  });
}

/**
 * FIFO record following "Example Amazon SQS message event (FIFO queue)":
 * https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#sample-fifo-queues-message-event
 * Includes the FIFO-only attributes SequenceNumber, MessageGroupId and MessageDeduplicationId
 * and the `.fifo` queue ARN. `sequence` increments the documented SequenceNumber so that
 * several records of one invocation stay ordered.
 */
export function sqsFifoRecord(
  body: string,
  options: {
    messageId: string;
    group?: string;
    dedup?: string;
    sequence?: number;
  },
) {
  return {
    messageId: options.messageId,
    receiptHandle: "AQEBBX8nesZEXmkhsmZeyIE8iQAMig7qw...",
    body,
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "1573251510774",
      SequenceNumber: String(
        18849496460467696128n + BigInt(options.sequence ?? 0),
      ),
      MessageGroupId: options.group ?? "1",
      SenderId: "AIDAIO23YVJENQZJOL4VO",
      MessageDeduplicationId: options.dedup ?? "1",
      ApproximateFirstReceiveTimestamp: "1573251510774",
    },
    messageAttributes: {},
    md5OfBody: md5(body),
    eventSource: "aws:sqs",
    eventSourceARN: FIFO_QUEUE_ARN,
    awsRegion: "us-east-2",
  };
}

/**
 * Function URL request, payload format 2.0, following "Request payload format":
 * https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html#urls-request-payload
 * (version, routeKey "$default", rawPath, rawQueryString, headers, queryStringParameters,
 * requestContext with http / domainName / requestId / stage / time / timeEpoch). Real captures
 * omit the documented-but-optional cookies, pathParameters, stageVariables, authentication and
 * authorizer keys for an unauthenticated URL, so the builder omits them too. The page states that a binary content type arrives base64-encoded with
 * isBase64Encoded true. The documented `<url-id>` placeholder becomes a syntactically valid
 * host label.
 */
export function functionUrlEvent(options: {
  method: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string>;
  body?: string | null;
  isBase64Encoded?: boolean;
}) {
  const host = "urlid.lambda-url.us-west-2.on.aws";
  const rawQueryString = options.rawQueryString ?? "";
  const queryStringParameters = Object.fromEntries(
    new URLSearchParams(rawQueryString),
  );
  // The real service reports requestContext.http.path without the trailing slash of rawPath.
  const path =
    options.rawPath.length > 1 && options.rawPath.endsWith("/")
      ? options.rawPath.slice(0, -1)
      : options.rawPath;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: options.rawPath,
    rawQueryString,
    // Real events carry lower-cased header names plus the headers the service adds.
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-port": "443",
      "x-forwarded-for": "203.0.113.10",
      "x-amzn-tls-version": "TLSv1.3",
      "x-amzn-tls-cipher-suite": "TLS_AES_128_GCM_SHA256",
      "x-amzn-trace-id": "Root=1-00000000-000000000000000000000000",
      host,
      ...options.headers,
    },
    // Present only when the query string is non-empty; there is no `cookies`,
    // `pathParameters`, `stageVariables`, `authentication` or `authorizer` for auth type NONE.
    ...(Object.keys(queryStringParameters).length > 0
      ? { queryStringParameters }
      : {}),
    requestContext: {
      accountId: "123456789012",
      apiId: "urlid",
      domainName: host,
      domainPrefix: "urlid",
      http: {
        method: options.method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "203.0.113.10",
        userAgent: "agent",
      },
      requestId: "e1506fd5-9e7b-434f-bd42-4f8fa224b599",
      routeKey: "$default",
      stage: "$default",
      time: "12/Mar/2020:19:03:58 +0000",
      timeEpoch: 1583348638390,
    },
    ...(options.body === undefined ? {} : { body: options.body }),
    isBase64Encoded: options.isBase64Encoded ?? false,
  };
}

/**
 * Default EventBridge scheduled-rule event, as delivered when the target has no Input
 * configured (structure of the "Scheduled Event" example in the EventBridge events reference,
 * https://docs.aws.amazon.com/eventbridge/latest/ref/events-ref-events.html and the event
 * overview https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-events.html):
 * detail-type "Scheduled Event", source "aws.events", the rule ARN in resources, empty detail.
 * errtraq's Terraform always sets a constant input, so this shape carries no job name.
 */
export const eventBridgeScheduledEvent = {
  version: "0",
  id: "53dc4d37-cffa-4f76-80c9-8b7d4a4d2eaa",
  "detail-type": "Scheduled Event",
  source: "aws.events",
  account: "123456789012",
  time: "2015-10-08T16:53:06Z",
  region: "us-east-1",
  resources: ["arn:aws:events:us-east-1:123456789012:rule/my-scheduled-rule"],
  detail: {},
};

/**
 * Scheduled rule target with "Constant (JSON text)" input: EventBridge sends only the
 * configured JSON ("No part of the original source event is sent"):
 * https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html
 * This is what infra/modules/aws/lambda-app configures (`input = jsonencode({ job = name })`).
 */
export const eventBridgeConstantInput = (job: string) => ({ job });

/**
 * EventBridge Scheduler without a payload invokes the function with an empty event:
 * https://docs.aws.amazon.com/lambda/latest/dg/with-eventbridge-scheduler.html
 */
export const eventBridgeSchedulerEmptyEvent = {};
