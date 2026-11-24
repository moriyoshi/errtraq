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
    runtime       = "nodejs20.x"
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
    condition     = aws_lambda_function.function["shared"].runtime == "nodejs20.x" && aws_lambda_function.function["shared"].handler == "app.handle" && aws_lambda_function.function["shared"].reserved_concurrent_executions == 12 && aws_lambda_function_url.http["shared"].authorization_type == "NONE" && toset(aws_lambda_function_url.http["shared"].cors[0].allow_origins) == toset(["*"]) && contains(aws_lambda_function_url.http["shared"].cors[0].allow_headers, "x-sentry-auth")
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
