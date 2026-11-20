mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/test" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:000000000000:log-group:test" }
  }
  mock_resource "aws_lambda_function" {
    defaults = { arn = "arn:aws:lambda:us-east-1:000000000000:function:test" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:events:us-east-1:000000000000:rule/test" }
  }
  mock_resource "aws_lambda_function_url" {
    defaults = { function_url = "https://example.invalid/" }
  }
}
run "functions_triggers_and_urls" {
  command = apply
  variables {
    name = "example"

    tags = {}
    functions = {
      shared = {
        roles                = ["ingest", "api", "consumer", "cron"]
        http                 = ["ingest", "api"]
        artifact             = "tests/artifact.txt"
        memory_mb            = 512
        timeout_sec          = 30
        architecture         = "arm64"
        auth_type            = "NONE"
        reserved_concurrency = 12
        environment          = { TABLE = "example" }
        secrets              = { SECRET_ID = "arn:aws:secretsmanager:us-east-1:000000000000:secret:test-123456" }
        secret_reads         = ["arn:aws:secretsmanager:us-east-1:000000000000:secret:test-123456"]
        policies             = ["{\"Version\":\"2012-10-17\",\"Statement\":[]}"]
      }
    }
    queue_triggers = {
      ingest = { function_id = "shared", resource = "arn:aws:sqs:us-east-1:000000000000:queue", topics = ["ingest"], batch_size = 5, max_concurrency = 7, visibility_timeout_sec = 180 }
    }
    cron_triggers = { retention = { function_id = "shared", schedule = "0 * * * *", retry_attempts = 4, max_event_age_seconds = 3600, dlq_arn = "arn:aws:sqs:us-east-1:000000000000:cron-dlq" } }
    runtime       = "nodejs20.x"
    handler       = "app.handle"
  }
  assert {
    condition     = length(aws_iam_role_policy.logs["shared"].policy) <= 1024
    error_message = "The logging policy must fit the 1024-character sizing budget."
  }
  assert {
    condition     = aws_lambda_function.function["shared"].runtime == "nodejs20.x" && aws_lambda_function.function["shared"].handler == "app.handle" && aws_lambda_function.function["shared"].reserved_concurrent_executions == 12 && aws_lambda_function_url.http["shared"].authorization_type == "NONE" && toset(aws_lambda_function_url.http["shared"].cors[0].allow_origins) == toset(["*"]) && contains(aws_lambda_function_url.http["shared"].cors[0].allow_headers, "X-Sentry-Auth")
    error_message = "Runtime, handler, concurrency, public auth and ingest CORS must match inputs."
  }
  assert {
    condition     = aws_cloudwatch_event_target.cron["retention"].retry_policy[0].maximum_retry_attempts == 4 && aws_cloudwatch_event_target.cron["retention"].retry_policy[0].maximum_event_age_in_seconds == 3600 && aws_cloudwatch_event_target.cron["retention"].dead_letter_config[0].arn == "arn:aws:sqs:us-east-1:000000000000:cron-dlq"
    error_message = "EventBridge retry and DLQ configuration must match inputs."
  }
  assert {
    condition     = output.ingest_url == "https://example.invalid/" && output.api_url == output.ingest_url
    error_message = "Both HTTP roles should expose the shared function URL."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.queue["ingest"].function_response_types == toset(["ReportBatchItemFailures"]) && aws_lambda_event_source_mapping.queue["ingest"].scaling_config[0].maximum_concurrency == 7
    error_message = "Queue mappings must support partial failures and configured concurrency."
  }
  assert {
    condition     = aws_cloudwatch_event_rule.cron["retention"].schedule_expression == "cron(0 * ? * * *)" && jsondecode(aws_cloudwatch_event_target.cron["retention"].input).job == "retention"
    error_message = "EventBridge must receive the converted cron schedule and job name."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.secret_reads["shared"].policy).Statement[0].Resource == ["arn:aws:secretsmanager:us-east-1:000000000000:secret:test-123456"]
    error_message = "Secret reads must be scoped to the function's secret ARN."
  }
}

run "visibility_too_short" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    functions      = { consumer = { roles = ["consumer"], http = [], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = { ingest = { function_id = "consumer", resource = "arn:aws:sqs:us-east-1:000000000000:queue", topics = ["ingest"], visibility_timeout_sec = 29 } }
    cron_triggers  = {}
  }
  expect_failures = [aws_lambda_event_source_mapping.queue["ingest"]]
}
run "private_url" {
  command = apply
  variables {
    name           = "example"
    tags           = {}
    functions      = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", auth_type = "AWS_IAM", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = aws_lambda_function_url.http["api"].authorization_type == "AWS_IAM" && length(aws_lambda_permission.url) == 0 && length(aws_lambda_function_url.http["api"].cors) == 0
    error_message = "IAM URLs must not receive public permissions or ingest CORS."
  }
}
run "inline_policy_limit" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    functions      = { ingest = { roles = ["ingest"], http = [], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [jsonencode({ Version = "2012-10-17", Statement = [], Extra = join("", [for i in range(1000) : "xxxxxxxxxxx"]) })] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [aws_iam_role.function["ingest"]]
}
