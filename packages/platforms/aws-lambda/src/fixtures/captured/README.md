# Captured AWS Lambda events

These six files are real Lambda invocation events captured on 2026-11-25 in the third real AWS
run (M3h), then scrubbed:

* `sqs-standard.json`, `sqs-fifo.json`: SQS event source mapping batches.
* `function-url-post.json`, `function-url-get.json`, `function-url-options.json`: Function URL
  (payload format 2.0) requests.
* `eventbridge-scheduled.json`: default EventBridge scheduled-rule event.

Scrubbing replaced the account id (123456789012), region (us-east-1), hosts (example), source IPs
(203.0.113.10), user agents, and request, trace and message ids (zero UUIDs and placeholders).
The SQS bodies are a probe's own JSON, not errtraq queue envelopes.

Any new capture must be scrubbed the same way before it is committed. Never add real identifiers.
The directory is excluded from the published npm package (`files` lists only `dist`).
Used by `src/aws-captures.test.ts`.
