mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "000000000000" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"sts:AssumeRole\"],\"Principal\":{\"Service\":[\"lambda.amazonaws.com\"]}}]}" }
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
  mock_data "aws_cloudfront_cache_policy" {
    defaults = { id = "00000000-0000-0000-0000-000000000001" }
  }
  mock_data "aws_cloudfront_origin_request_policy" {
    defaults = { id = "00000000-0000-0000-0000-000000000002" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::example-ui-123", id = "example-ui-123", bucket_regional_domain_name = "example-ui-123.s3.us-east-1.amazonaws.com" }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = { arn = "arn:aws:cloudfront::000000000000:distribution/EXAMPLE", id = "EXAMPLE", domain_name = "d111111abcdef8.cloudfront.net" }
  }
  mock_resource "aws_cloudfront_function" {
    defaults = { arn = "arn:aws:cloudfront::000000000000:function/example-ui-spa" }
  }
}
run "functions_triggers_and_urls" {
  command = apply
  variables {
    name = "example"

    tags = {}
    functions = {
      shared = {
        roles                = ["ingest", "api", "consumer", "record"]
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
        policies             = [jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["s3:GetObject"], Resource = ["arn:aws:s3:::example-bucket/envelopes/*"] }] })]
      }
      worker = {
        roles        = ["cron"]
        http         = []
        artifact     = "tests/artifact.txt"
        memory_mb    = 256
        timeout_sec  = 30
        architecture = "x86_64"
        environment  = { QUEUE = "worker-only" }
        secrets      = {}
        secret_reads = []
        policies     = [jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = ["arn:aws:sqs:us-east-1:000000000000:queue"] }] })]
      }
    }
    queue_triggers = {
      ingest = { function_id = "shared", resource = "arn:aws:sqs:us-east-1:000000000000:queue", topics = ["ingest"], batch_size = 5, max_concurrency = 7, visibility_timeout_sec = 180 }
      record = { function_id = "shared", resource = "arn:aws:sqs:us-east-1:000000000000:record.fifo", topics = ["record"], batch_size = 10, visibility_timeout_sec = 180 }
    }
    cron_triggers = { retention = { function_id = "worker", schedule = "0 * * * *", retry_attempts = 4, max_event_age_seconds = 3600, dlq_arn = "arn:aws:sqs:us-east-1:000000000000:cron-dlq" } }
    runtime       = "nodejs22.x"
    handler       = "app.handle"
  }
  assert {
    condition     = aws_lambda_event_source_mapping.queue["record"].event_source_arn == "arn:aws:sqs:us-east-1:000000000000:record.fifo" && aws_lambda_event_source_mapping.queue["record"].batch_size == 10 && aws_lambda_event_source_mapping.queue["record"].function_response_types == toset(["ReportBatchItemFailures"])
    error_message = "FIFO record delivery must use the derived ARN, batch size and partial failures."
  }
  assert {
    condition     = length(data.aws_iam_policy_document.assume.statement) == 1 && length(data.aws_iam_policy_document.assume.statement[0].condition) == 0 && length(data.aws_iam_policy_document.assume.statement[0].not_principals) == 0 && data.aws_iam_policy_document.assume.statement[0].not_actions == null && coalesce(data.aws_iam_policy_document.assume.statement[0].effect, "Allow") == "Allow" && aws_iam_role.function["shared"].assume_role_policy == data.aws_iam_policy_document.assume.json && aws_iam_role.function["worker"].assume_role_policy == data.aws_iam_policy_document.assume.json && jsonencode(data.aws_iam_policy_document.assume.statement[0].actions) == jsonencode(["sts:AssumeRole"]) && length(data.aws_iam_policy_document.assume.statement[0].principals) == 1 && one(data.aws_iam_policy_document.assume.statement[0].principals).type == "Service" && toset(one(data.aws_iam_policy_document.assume.statement[0].principals).identifiers) == toset(["lambda.amazonaws.com"])
    error_message = "Lambda trust must allow only the Lambda service principal and sts:AssumeRole."
  }
  assert {
    condition     = length(aws_iam_role_policy.capability) == 2 && aws_iam_role.function["shared"].id != aws_iam_role.function["worker"].id && aws_iam_role_policy.capability["shared-0"].role == aws_iam_role.function["shared"].id && aws_iam_role_policy.capability["worker-0"].role == aws_iam_role.function["worker"].id && aws_iam_role_policy.capability["shared-0"].policy == var.functions["shared"].policies[0] && aws_iam_role_policy.capability["worker-0"].policy == var.functions["worker"].policies[0]
    error_message = "Different functions must receive only their own capability policies."
  }
  assert {
    condition     = jsonencode(aws_lambda_function.function["shared"].environment[0].variables) == jsonencode({ TABLE = "example", SECRET_ID = "arn:aws:secretsmanager:us-east-1:000000000000:secret:test-123456" }) && jsonencode(aws_lambda_function.function["worker"].environment[0].variables) == jsonencode({ QUEUE = "worker-only" })
    error_message = "Each function environment must contain exactly its own values."
  }
  assert {
    condition     = alltrue([for id in ["shared", "worker"] : jsonencode(jsondecode(aws_iam_role_policy.logs[id].policy)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.function[id].arn}:*" }] }) && aws_iam_role_policy.logs[id].role == aws_iam_role.function[id].id]) && jsonencode(jsondecode(aws_iam_role_policy.secret_reads["shared"].policy)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = ["arn:aws:secretsmanager:us-east-1:000000000000:secret:test-123456"] }] }) && aws_iam_role_policy.secret_reads["shared"].role == aws_iam_role.function["shared"].id && !contains(keys(aws_iam_role_policy.secret_reads), "worker")
    error_message = "Logging and secret-read policies must have exact actions, resources and role scopes."
  }
  assert {
    condition     = length(aws_s3_object.artifact) == 0 && aws_lambda_function.function["shared"].filename == "tests/artifact.txt" && aws_lambda_function.function["shared"].s3_bucket == null && aws_lambda_function.function["shared"].s3_key == null
    error_message = "Without an artifact bucket, Lambda must use direct upload."
  }
  assert {
    condition     = length(aws_iam_role_policy.vpc) == 0 && alltrue([for fn in values(aws_lambda_function.function) : length(fn.vpc_config) == 0])
    error_message = "Functions without VPC configuration must not receive VPC permissions."
  }
  assert {
    condition     = length(aws_iam_role_policy.logs["shared"].policy) <= 1024
    error_message = "The logging policy must fit the 1024-character sizing budget."
  }
  assert {
    condition     = aws_lambda_function.function["shared"].runtime == "nodejs22.x" && aws_lambda_function.function["shared"].handler == "app.handle" && aws_lambda_function.function["shared"].reserved_concurrent_executions == 12 && aws_lambda_function_url.http["shared"].authorization_type == "NONE" && toset(aws_lambda_function_url.http["shared"].cors[0].allow_origins) == toset(["*"]) && contains(aws_lambda_function_url.http["shared"].cors[0].allow_headers, "x-sentry-auth")
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
  assert {
    condition = toset(keys(aws_cloudwatch_metric_alarm.errors)) == toset(["shared", "worker"]) && alltrue([for id, alarm in aws_cloudwatch_metric_alarm.errors :
      alarm.alarm_name == "example-${id}-errors" && alarm.namespace == "AWS/Lambda" && alarm.metric_name == "Errors" && alarm.statistic == "Sum" && alarm.period == 300 && alarm.evaluation_periods == 1 && alarm.datapoints_to_alarm == 1 &&
      alarm.threshold == 0 && alarm.comparison_operator == "GreaterThanThreshold" && alarm.treat_missing_data == "notBreaching" && jsonencode(alarm.dimensions) == jsonencode({ FunctionName = "example-${id}" }) && length(alarm.alarm_actions) == 0 && alarm.ok_actions == null
    ])
    error_message = "Every physical function needs exactly one exact Errors alarm and no actions without an operator topic."
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
run "api_browser_access_and_ingest_url" {
  command = apply
  variables {
    name              = "example"
    tags              = {}
    ingest_public_url = "https://ingest.example.com/prefix"
    api_cors_origins  = ["https://ui.example.com", "http://localhost:5173"]
    functions = {
      api    = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = { TABLE = "t" }, secrets = {}, secret_reads = [], policies = [] }
      ingest = { roles = ["ingest"], http = ["ingest"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] }
    }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = length(aws_lambda_function_url.http["api"].cors) == 1 && toset(one(aws_lambda_function_url.http["api"].cors).allow_origins) == toset(["https://ui.example.com", "http://localhost:5173"]) && toset(one(aws_lambda_function_url.http["api"].cors).allow_methods) == toset(["GET", "PUT", "POST"]) && toset(one(aws_lambda_function_url.http["api"].cors).allow_headers) == toset(["authorization", "content-type"]) && toset(one(aws_lambda_function_url.http["api"].cors).expose_headers) == toset(["link"]) && one(aws_lambda_function_url.http["api"].cors).allow_credentials == false && one(aws_lambda_function_url.http["api"].cors).max_age == 86400
    error_message = "The API URL must allow exactly the configured origins, the API methods and headers, and expose Link."
  }
  assert {
    condition     = toset(one(aws_lambda_function_url.http["ingest"].cors).allow_origins) == toset(["*"]) && toset(one(aws_lambda_function_url.http["ingest"].cors).allow_methods) == toset(["POST"])
    error_message = "The ingest URL keeps its own public CORS policy."
  }
  assert {
    condition     = jsonencode(aws_lambda_function.function["api"].environment[0].variables) == jsonencode({ TABLE = "t", ERRTRAQ_PUBLIC_INGEST_URL = "https://ingest.example.com/prefix" }) && !contains(keys(try(aws_lambda_function.function["ingest"].environment[0].variables, {})), "ERRTRAQ_PUBLIC_INGEST_URL")
    error_message = "Only the API function receives the public ingest URL."
  }
}
run "api_without_cors_or_ingest_url" {
  command = apply
  variables {
    name           = "example"
    tags           = {}
    functions      = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = length(aws_lambda_function_url.http["api"].cors) == 0 && !contains(keys(aws_lambda_function.function["api"].environment[0].variables), "ERRTRAQ_PUBLIC_INGEST_URL")
    error_message = "Without settings the API URL has no CORS block and the function no ingest URL."
  }
}
run "api_cors_rejected_on_shared_ingest_function" {
  command = plan
  variables {
    name             = "example"
    tags             = {}
    api_cors_origins = ["https://ui.example.com"]
    functions        = { shared = { roles = ["ingest", "api"], http = ["ingest", "api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers   = {}
    cron_triggers    = {}
  }
  expect_failures = [var.api_cors_origins]
}
run "api_cors_rejects_wildcards_and_paths" {
  command = plan
  variables {
    name             = "example"
    tags             = {}
    api_cors_origins = ["*"]
    functions        = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers   = {}
    cron_triggers    = {}
  }
  expect_failures = [var.api_cors_origins]
}
run "ingest_public_url_rejects_credentials" {
  command = plan
  variables {
    name              = "example"
    tags              = {}
    ingest_public_url = "https://user:pass@ingest.example.com"
    functions         = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers    = {}
    cron_triggers     = {}
  }
  expect_failures = [var.ingest_public_url]
}
run "web_ui_behind_cloudfront" {
  command = apply
  variables {
    name = "example"
    tags = {}
    ui   = { build_anchor = "tests/ui-build/api/bundle.zip" }
    functions = {
      api    = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] }
      ingest = { roles = ["ingest"], http = ["ingest"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] }
    }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = length(module.static_site) == 1 && output.ui_domain_name == "d111111abcdef8.cloudfront.net" && output.ui_distribution_id == "EXAMPLE" && output.ui_bucket_name == "example-ui-123"
    error_message = "The UI outputs must come from the static-site module."
  }
  assert {
    condition     = aws_lambda_function_url.http["api"].authorization_type == "NONE" && length(aws_lambda_function_url.http["api"].cors) == 0
    error_message = "The API URL stays public (it checks the Bearer token itself) and needs no CORS behind the same-origin distribution."
  }
}
run "public_api_url_and_custom_domain" {
  command = apply
  variables {
    name           = "example"
    tags           = {}
    public_api_url = "https://errtraq.example.com"
    ui = {
      build_anchor    = "tests/ui-build/api/bundle.zip"
      aliases         = ["errtraq.example.com"]
      certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
      waf_acl_arn     = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/errtraq/11111111-2222-3333-4444-555555555555"
    }
    functions = {
      api    = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = { TABLE = "t" }, secrets = {}, secret_reads = [], policies = [] }
      ingest = { roles = ["ingest"], http = ["ingest"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] }
    }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = jsonencode(aws_lambda_function.function["api"].environment[0].variables) == jsonencode({ TABLE = "t", ERRTRAQ_PUBLIC_API_URL = "https://errtraq.example.com" }) && !contains(keys(try(aws_lambda_function.function["ingest"].environment[0].variables, {})), "ERRTRAQ_PUBLIC_API_URL")
    error_message = "Only the API function receives the public API URL."
  }
}
run "public_api_url_rejects_a_path" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    public_api_url = "https://errtraq.example.com/api"
    functions      = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.public_api_url]
}
run "custom_domain_needs_a_us_east_1_certificate" {
  command = plan
  variables {
    name = "example"
    tags = {}
    ui = {
      build_anchor    = "tests/ui-build/api/bundle.zip"
      aliases         = ["errtraq.example.com"]
      certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
    }
    functions      = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.ui]
}
run "no_web_ui_by_default" {
  command = apply
  variables {
    name           = "example"
    tags           = {}
    functions      = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = length(module.static_site) == 0 && output.ui_domain_name == "" && output.ui_distribution_id == "" && output.ui_bucket_name == ""
    error_message = "Without ui nothing is created and the outputs are empty."
  }
}
run "web_ui_needs_a_public_api_function" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    ui             = { build_anchor = "tests/ui-build/api/bundle.zip" }
    functions      = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", auth_type = "AWS_IAM", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.ui]
}
run "web_ui_needs_the_api_exposed" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    ui             = { build_anchor = "tests/ui-build/ingest/bundle.zip" }
    functions      = { ingest = { roles = ["ingest"], http = ["ingest"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.ui]
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

run "vpc_configuration" {
  command = apply
  variables {
    name                   = "vpc-test"
    tags                   = {}
    vpc_subnet_ids         = ["subnet-12345678", "subnet-abcdef12"]
    vpc_security_group_ids = ["sg-12345678"]
    functions = {
      api = {
        roles        = ["api"]
        http         = ["api"]
        artifact     = "tests/artifact.txt"
        memory_mb    = 512
        timeout_sec  = 30
        architecture = "arm64"
        environment  = {}
        secrets      = {}
        secret_reads = []
        policies     = []
      }
      worker = {
        roles        = ["consumer"]
        http         = []
        artifact     = "tests/artifact.txt"
        memory_mb    = 512
        timeout_sec  = 30
        architecture = "arm64"
        environment  = {}
        secrets      = {}
        secret_reads = []
        policies     = []
      }
    }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = alltrue([for id in ["api", "worker"] : toset(aws_lambda_function.function[id].vpc_config[0].subnet_ids) == toset(var.vpc_subnet_ids) && toset(aws_lambda_function.function[id].vpc_config[0].security_group_ids) == toset(var.vpc_security_group_ids) && aws_iam_role_policy.vpc[id].role == aws_iam_role.function[id].id && jsonencode(jsondecode(aws_iam_role_policy.vpc[id].policy)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets", "ec2:DeleteNetworkInterface", "ec2:AssignPrivateIpAddresses", "ec2:UnassignPrivateIpAddresses"], Resource = ["*"] }] })])
    error_message = "Each VPC function requires the exact configured subnets, security groups and ENI role permissions."
  }
}
run "incomplete_vpc" {
  command = plan
  variables {
    name           = "vpc-test"
    tags           = {}
    vpc_subnet_ids = ["subnet-12345678"]
    functions = {
      api = {
        roles        = ["api"]
        http         = ["api"]
        artifact     = "tests/artifact.txt"
        memory_mb    = 512
        timeout_sec  = 30
        architecture = "arm64"
        environment  = {}
        secrets      = {}
        secret_reads = []
        policies     = []
      }
    }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [aws_lambda_function.function["api"]]
}

run "alarm_actions_and_tags" {
  command = apply
  variables {
    name            = "example"
    tags            = { stack = "example" }
    alarm_topic_arn = "arn:aws:sns:us-east-1:000000000000:operators"
    functions       = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers  = {}
    cron_triggers   = {}
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.errors) == 1 && aws_cloudwatch_metric_alarm.errors["api"].alarm_actions == toset(["arn:aws:sns:us-east-1:000000000000:operators"]) && jsonencode(aws_cloudwatch_metric_alarm.errors["api"].tags) == jsonencode({ stack = "example" })
    error_message = "The operator topic and stack tags must be applied to the Errors alarm."
  }
}
run "invalid_alarm_topic" {
  command = plan
  variables {
    name            = "example"
    tags            = {}
    alarm_topic_arn = "arn:aws:sqs:us-east-1:000000000000:operators"
    functions       = { api = { roles = ["api"], http = ["api"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers  = {}
    cron_triggers   = {}
  }
  expect_failures = [var.alarm_topic_arn]
}

run "s3_artifact_deployment" {
  command = apply
  variables {
    name            = "example"
    tags            = {}
    artifact_bucket = "existing-deployment-bucket"
    functions = {
      ingest = { roles = ["ingest"], http = ["ingest"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] }
    }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = length(aws_s3_object.artifact) == 1 && aws_s3_object.artifact["ingest"].bucket == "existing-deployment-bucket" && aws_s3_object.artifact["ingest"].source == "tests/artifact.txt" && aws_s3_object.artifact["ingest"].key == "example/ingest/${filesha256("tests/artifact.txt")}.zip" && aws_s3_object.artifact["ingest"].source_hash == filebase64sha256("tests/artifact.txt") && aws_s3_object.artifact["ingest"].server_side_encryption == "AES256"
    error_message = "S3 artifacts must use the operator bucket, encrypted content-addressed object and correct source."
  }
  assert {
    condition     = aws_lambda_function.function["ingest"].filename == null && aws_lambda_function.function["ingest"].s3_bucket == "existing-deployment-bucket" && aws_lambda_function.function["ingest"].s3_key == aws_s3_object.artifact["ingest"].key && aws_lambda_function.function["ingest"].source_code_hash == filebase64sha256("tests/artifact.txt")
    error_message = "Lambda must deploy the uploaded object with the local content hash."
  }
}

run "bootstrap_function" {
  command = apply
  variables {
    name                   = "example"
    tags                   = {}
    bootstrap_secret_name  = "errtraq/bootstrap/example"
    vpc_subnet_ids         = ["subnet-12345678"]
    vpc_security_group_ids = ["sg-12345678"]
    functions = {
      ingest    = { roles = ["ingest"], http = ["ingest"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = { TABLE = "store" }, secrets = {}, secret_reads = [], policies = [] }
      bootstrap = { roles = ["bootstrap"], http = [], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 120, architecture = "arm64", environment = { TABLE = "store" }, secrets = { ADMIN = "arn:aws:secretsmanager:us-east-1:000000000000:secret:admin-ABC123" }, secret_reads = ["arn:aws:secretsmanager:us-east-1:000000000000:secret:admin-ABC123"], policies = [] }
    }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = toset(keys(aws_iam_role_policy.bootstrap_secret)) == toset(["bootstrap"]) && aws_iam_role_policy.bootstrap_secret["bootstrap"].role == aws_iam_role.function["bootstrap"].id && jsonencode(jsondecode(aws_iam_role_policy.bootstrap_secret["bootstrap"].policy)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], Resource = ["arn:aws:secretsmanager:us-east-1:000000000000:secret:errtraq/bootstrap/example-??????"] }] })
    error_message = "Only the bootstrap function may create and read exactly the bootstrap secret."
  }
  assert {
    condition     = jsonencode(aws_lambda_function.function["bootstrap"].environment[0].variables) == jsonencode({ ADMIN = "arn:aws:secretsmanager:us-east-1:000000000000:secret:admin-ABC123", ERRTRAQ_BOOTSTRAP_SECRET_NAME = "errtraq/bootstrap/example", TABLE = "store" }) && jsonencode(aws_lambda_function.function["ingest"].environment[0].variables) == jsonencode({ TABLE = "store" })
    error_message = "The bootstrap secret name is delivered to the bootstrap function and to no other."
  }
  assert {
    condition     = toset(keys(aws_lambda_function_url.http)) == toset(["ingest"]) && length(aws_lambda_permission.url) == 1 && length(aws_lambda_event_source_mapping.queue) == 0 && length(aws_cloudwatch_event_target.cron) == 0
    error_message = "The bootstrap function has no URL, public permission or trigger."
  }
  assert {
    condition     = toset(aws_lambda_function.function["bootstrap"].vpc_config[0].subnet_ids) == toset(var.vpc_subnet_ids) && toset(aws_lambda_function.function["bootstrap"].vpc_config[0].security_group_ids) == toset(var.vpc_security_group_ids) && length(aws_iam_role_policy.vpc) == 2
    error_message = "The bootstrap function shares the platform VPC placement."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.secret_reads["bootstrap"].policy).Statement[0].Resource == ["arn:aws:secretsmanager:us-east-1:000000000000:secret:admin-ABC123"] && !contains(keys(aws_iam_role_policy.secret_reads), "ingest")
    error_message = "Only the bootstrap function reads the administrator secret."
  }
  assert {
    condition     = output.bootstrap_function_name == "example-bootstrap" && output.bootstrap_function_arn == aws_lambda_function.function["bootstrap"].arn
    error_message = "The bootstrap function name and ARN are exported for lambda:InvokeFunction."
  }
}
run "no_bootstrap_function" {
  command = apply
  variables {
    name           = "example"
    tags           = {}
    functions      = { ingest = { roles = ["ingest"], http = ["ingest"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = length(aws_iam_role_policy.bootstrap_secret) == 0 && length(data.aws_region.current) == 0 && output.bootstrap_function_name == "" && output.bootstrap_function_arn == "" && !contains(keys(aws_lambda_function.function["ingest"].environment[0].variables), "ERRTRAQ_BOOTSTRAP_SECRET_NAME")
    error_message = "Without the bootstrap role nothing bootstrap-related exists."
  }
}
run "bootstrap_requires_secret_name" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    functions      = { bootstrap = { roles = ["bootstrap"], http = [], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 120, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.bootstrap_secret_name]
}
run "secret_name_without_bootstrap" {
  command = plan
  variables {
    name                  = "example"
    tags                  = {}
    bootstrap_secret_name = "errtraq/bootstrap/example"
    functions             = { ingest = { roles = ["ingest"], http = ["ingest"], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers        = {}
    cron_triggers         = {}
  }
  expect_failures = [var.bootstrap_secret_name]
}
run "bootstrap_is_never_grouped" {
  command = plan
  variables {
    name                  = "example"
    tags                  = {}
    bootstrap_secret_name = "errtraq/bootstrap/example"
    functions             = { shared = { roles = ["consumer", "bootstrap"], http = [], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 120, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers        = {}
    cron_triggers         = {}
  }
  expect_failures = [var.functions]
}
run "bootstrap_has_no_triggers" {
  command = plan
  variables {
    name                  = "example"
    tags                  = {}
    bootstrap_secret_name = "errtraq/bootstrap/example"
    functions             = { bootstrap = { roles = ["bootstrap"], http = [], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 120, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers        = {}
    cron_triggers         = { retention = { function_id = "bootstrap", schedule = "0 * * * *" } }
  }
  expect_failures = [var.cron_triggers]
}

run "runtime_defaults_to_nodejs26_and_rejects_unsupported" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    functions      = { ingest = { roles = ["ingest"], http = [], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = aws_lambda_function.function["ingest"].runtime == "nodejs26.x"
    error_message = "runtime must default to nodejs26.x."
  }
}

run "runtime_rejects_unsupported" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    runtime        = "nodejs20.x"
    functions      = { ingest = { roles = ["ingest"], http = [], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.runtime]
}

# D6: the archive role and the archive-reading API run from one container image; the function's
# image command picks its bundle, and the module creates the ECR repository the image goes to.
run "container_image_functions" {
  command = apply
  variables {
    name      = "example"
    tags      = {}
    image_uri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/example@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    functions = {
      api = {
        roles                = ["api"]
        http                 = ["api"]
        artifact             = "tests/artifact.txt"
        package_type         = "Image"
        memory_mb            = 1024
        timeout_sec          = 30
        architecture         = "arm64"
        ephemeral_storage_mb = 1024
        environment          = {}
        secrets              = {}
        secret_reads         = []
        policies             = []
      }
      archive = {
        roles                = ["archive"]
        http                 = []
        artifact             = "tests/artifact.txt"
        package_type         = "Image"
        memory_mb            = 1024
        timeout_sec          = 300
        architecture         = "arm64"
        ephemeral_storage_mb = 2048
        environment          = {}
        secrets              = {}
        secret_reads         = []
        policies             = []
      }
      consumer = {
        roles        = ["consumer"]
        http         = []
        artifact     = "tests/artifact.txt"
        memory_mb    = 512
        timeout_sec  = 30
        architecture = "x86_64"
        environment  = {}
        secrets      = {}
        secret_reads = []
        policies     = []
      }
    }
    queue_triggers = {
      archive_project = { function_id = "archive", resource = "arn:aws:sqs:us-east-1:000000000000:archive", topics = ["archive.project"], batch_size = 1, max_concurrency = 5, visibility_timeout_sec = 1800 }
    }
    cron_triggers = {
      archive-planner = { function_id = "archive", schedule = "0 * * * *" }
      retention       = { function_id = "archive", schedule = "15 * * * *" }
    }
  }
  assert {
    condition     = alltrue([for id in ["api", "archive"] : aws_lambda_function.function[id].package_type == "Image" && aws_lambda_function.function[id].image_uri == var.image_uri && jsonencode(one(aws_lambda_function.function[id].image_config).command) == jsonencode(["${id}/index.handler"]) && jsonencode(aws_lambda_function.function[id].architectures) == jsonencode(["arm64"])])
    error_message = "Image functions use the image, their own bundle command and no ZIP settings."
  }
  assert {
    condition     = one(aws_lambda_function.function["archive"].ephemeral_storage).size == 2048 && one(aws_lambda_function.function["api"].ephemeral_storage).size == 1024 && one(aws_lambda_function.function["consumer"].ephemeral_storage).size == 512 && aws_lambda_function.function["archive"].memory_size == 1024 && aws_lambda_function.function["archive"].timeout == 300
    error_message = "The archive function gets its /tmp, memory and timeout sizing; ZIP functions keep the default /tmp."
  }
  assert {
    condition     = aws_lambda_function.function["consumer"].package_type == "Zip" && aws_lambda_function.function["consumer"].runtime == "nodejs26.x" && length(aws_lambda_function.function["consumer"].image_config) == 0
    error_message = "ZIP functions are unchanged beside image functions."
  }
  assert {
    condition     = aws_ecr_repository.image[0].image_tag_mutability == "IMMUTABLE" && one(aws_ecr_repository.image[0].image_scanning_configuration).scan_on_push && one(aws_ecr_repository.image[0].encryption_configuration).encryption_type == "AES256" && aws_ecr_repository.image[0].name == "example" && length(aws_ecr_repository.image) == 1
    error_message = "The ECR repository must have immutable tags, scanning on push and encryption."
  }
  assert {
    condition     = jsondecode(aws_ecr_repository_policy.image[0].policy).Statement[0].Principal.Service == "lambda.amazonaws.com" && jsonencode(jsondecode(aws_ecr_repository_policy.image[0].policy).Statement[0].Action) == jsonencode(["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]) && jsondecode(aws_ecr_repository_policy.image[0].policy).Statement[0].Condition.StringLike["aws:sourceArn"] == "arn:aws:lambda:us-east-1:000000000000:function:example-*"
    error_message = "Only this stack's Lambda functions may pull the image, and only to read it."
  }
  assert {
    condition     = aws_lambda_event_source_mapping.queue["archive_project"].batch_size == 1 && one(aws_lambda_event_source_mapping.queue["archive_project"].scaling_config).maximum_concurrency == 5 && length(aws_lambda_permission.cron) == 2 && aws_cloudwatch_event_target.cron["retention"].arn == aws_lambda_function.function["archive"].arn
    error_message = "The archive queue and its schedules must target the archive function."
  }
  assert {
    condition     = length(aws_s3_object.artifact) == 0
    error_message = "Image functions have no ZIP upload."
  }
}

run "no_repository_without_image_functions" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    functions      = { ingest = { roles = ["ingest"], http = [], artifact = "tests/artifact.txt", memory_mb = 512, timeout_sec = 30, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  assert {
    condition     = length(aws_ecr_repository.image) == 0
    error_message = "No repository without an image function."
  }
}

run "image_uri_required_with_image_functions" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    functions      = { archive = { roles = ["archive"], http = [], artifact = "tests/artifact.txt", package_type = "Image", memory_mb = 1024, timeout_sec = 300, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.image_uri]
}

run "image_uri_must_be_an_ecr_reference" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    image_uri      = "docker.io/library/app:latest"
    functions      = { archive = { roles = ["archive"], http = [], artifact = "tests/artifact.txt", package_type = "Image", memory_mb = 1024, timeout_sec = 300, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.image_uri]
}

run "archive_role_is_an_unexposed_image_function" {
  command = plan
  variables {
    name           = "example"
    tags           = {}
    image_uri      = "123456789012.dkr.ecr.us-east-1.amazonaws.com/example:v1"
    functions      = { archive = { roles = ["archive"], http = [], artifact = "tests/artifact.txt", memory_mb = 1024, timeout_sec = 300, architecture = "arm64", environment = {}, secrets = {}, secret_reads = [], policies = [] } }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.functions]
}
