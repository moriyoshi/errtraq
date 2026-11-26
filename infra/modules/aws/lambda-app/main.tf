locals {
  public_functions = { for id, fn in local.http_functions : id => fn if fn.auth_type == "NONE" }
  http_functions   = { for id, fn in var.functions : id => fn if length(fn.http) > 0 }
  role_urls        = { for role in ["ingest", "api"] : role => length([for fn in values(local.http_functions) : fn if contains(fn.http, role)]) > 0 ? one([for id, fn in local.http_functions : aws_lambda_function_url.http[id].function_url if contains(fn.http, role)]) : "" }
  policies         = { for item in flatten([for id, fn in var.functions : [for index, policy in fn.policies : { key = "${id}-${index}", id = id, policy = policy }]]) : item.key => item }
  secret_functions = { for id, fn in var.functions : id => fn if length(fn.secret_reads) > 0 }
  # Core emits standard five-field cron; EventBridge requires six fields and ? in one day field.
  cron                = { for job, trigger in var.cron_triggers : job => split(" ", trigger.schedule) }
  bootstrap_functions = { for id, fn in var.functions : id => fn if contains(fn.roles, "bootstrap") }
  image_functions     = { for id, fn in var.functions : id => fn if fn.package_type == "Image" }
  zip_functions       = { for id, fn in var.functions : id => fn if fn.package_type == "Zip" }
  # The data sources below serve the bootstrap secret ARN and the ECR repository policy.
  needs_account = length(local.bootstrap_functions) > 0 || length(local.image_functions) > 0
  vpc_enabled   = length(var.vpc_subnet_ids) > 0 && length(var.vpc_security_group_ids) > 0
  vpc_policy    = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["ec2:CreateNetworkInterface", "ec2:DescribeNetworkInterfaces", "ec2:DescribeSubnets", "ec2:DeleteNetworkInterface", "ec2:AssignPrivateIpAddresses", "ec2:UnassignPrivateIpAddresses"], Resource = ["*"] }] })
}
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}
data "aws_caller_identity" "current" {
  count = local.needs_account ? 1 : 0
}
data "aws_partition" "current" {
  count = local.needs_account ? 1 : 0
}
data "aws_region" "current" {
  count = local.needs_account ? 1 : 0
}
resource "aws_iam_role" "function" {
  for_each           = var.functions
  name               = "${var.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
  lifecycle {
    precondition {
      condition     = sum(concat([0], [for policy in each.value.policies : length(jsonencode(jsondecode(policy)))])) <= 10240 && sum(concat([0], [for policy in each.value.policies : length(jsonencode(jsondecode(policy)))])) + length(jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.function[each.key].arn}:*" }] })) + (length(each.value.secret_reads) == 0 ? 0 : length(jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = distinct(each.value.secret_reads) }] }))) + (local.vpc_enabled ? length(local.vpc_policy) : 0) <= 10240
      error_message = "Aggregate inline policies exceed the 10240-character IAM role limit."
    }
  }
}
resource "aws_cloudwatch_log_group" "function" {
  for_each          = var.functions
  name              = "/aws/lambda/${var.name}-${each.key}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}
resource "aws_iam_role_policy" "logs" {
  for_each = var.functions
  name     = "logs"
  role     = aws_iam_role.function[each.key].id
  policy   = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.function[each.key].arn}:*" }] })
}
resource "aws_iam_role_policy" "capability" {
  for_each = local.policies
  name     = "capability-${each.key}"
  role     = aws_iam_role.function[each.value.id].id
  policy   = each.value.policy
}
resource "aws_iam_role_policy" "secret_reads" {
  for_each = local.secret_functions
  name     = "secret-reads"
  role     = aws_iam_role.function[each.key].id
  policy   = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = distinct(each.value.secret_reads) }] })
}
# The bootstrap function creates (or, on a rerun, reads) exactly one secret and may do nothing else
# with Secrets Manager. Secrets Manager appends a hyphen and six characters to the name in the ARN.
resource "aws_iam_role_policy" "bootstrap_secret" {
  for_each = local.bootstrap_functions
  name     = "bootstrap-secret"
  role     = aws_iam_role.function[each.key].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow"
    Action   = ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    Resource = ["arn:${data.aws_partition.current[0].partition}:secretsmanager:${data.aws_region.current[0].region}:${data.aws_caller_identity.current[0].account_id}:secret:${var.bootstrap_secret_name}-??????"]
  }] })
}
resource "aws_iam_role_policy" "vpc" {
  for_each = local.vpc_enabled ? var.functions : {}
  name     = "vpc-network-interfaces"
  role     = aws_iam_role.function[each.key].id
  policy   = local.vpc_policy
}
# The operator supplies the bucket; no public access or bucket is created by this module.
resource "aws_s3_object" "artifact" {
  for_each               = var.artifact_bucket == null ? {} : local.zip_functions
  bucket                 = var.artifact_bucket
  key                    = "${var.name}/${each.key}/${filesha256(each.value.artifact)}.zip"
  source                 = each.value.artifact
  source_hash            = filebase64sha256(each.value.artifact)
  server_side_encryption = "AES256"
}
resource "aws_lambda_function" "function" {
  for_each                       = var.functions
  function_name                  = "${var.name}-${each.key}"
  role                           = aws_iam_role.function[each.key].arn
  package_type                   = each.value.package_type
  runtime                        = each.value.package_type == "Zip" ? var.runtime : null
  handler                        = each.value.package_type == "Zip" ? var.handler : null
  reserved_concurrent_executions = each.value.reserved_concurrency
  filename                       = each.value.package_type == "Zip" && var.artifact_bucket == null ? each.value.artifact : null
  s3_bucket                      = each.value.package_type == "Zip" ? var.artifact_bucket : null
  s3_key                         = each.value.package_type == "Zip" && var.artifact_bucket != null ? aws_s3_object.artifact[each.key].key : null
  source_code_hash               = each.value.package_type == "Zip" ? filebase64sha256(each.value.artifact) : null
  image_uri                      = each.value.package_type == "Image" ? var.image_uri : null
  memory_size                    = each.value.memory_mb
  timeout                        = each.value.timeout_sec
  architectures                  = [each.value.architecture]
  ephemeral_storage {
    size = each.value.ephemeral_storage_mb
  }
  # One image carries every image function's bundle under <function id>/; the command selects it.
  dynamic "image_config" {
    for_each = each.value.package_type == "Image" ? [1] : []
    content {
      command = ["${each.key}/${var.handler}"]
    }
  }
  environment { variables = merge(each.value.environment, each.value.secrets, contains(each.value.roles, "bootstrap") ? { ERRTRAQ_BOOTSTRAP_SECRET_NAME = var.bootstrap_secret_name } : {}, contains(each.value.http, "api") && var.ingest_public_url != null ? { ERRTRAQ_PUBLIC_INGEST_URL = var.ingest_public_url } : {}, contains(each.value.http, "api") && var.auth_config != null ? { ERRTRAQ_AUTH_CONFIG = jsonencode(var.auth_config) } : {}) }
  dynamic "vpc_config" {
    for_each = local.vpc_enabled ? [1] : []
    content {
      subnet_ids         = var.vpc_subnet_ids
      security_group_ids = var.vpc_security_group_ids
    }
  }
  lifecycle {
    precondition {
      condition     = (length(var.vpc_subnet_ids) == 0) == (length(var.vpc_security_group_ids) == 0)
      error_message = "VPC subnet IDs and security group IDs must be provided together."
    }
    precondition {
      condition     = each.value.package_type == "Zip" || var.image_uri != null
      error_message = "A container-image function requires image_uri."
    }
  }
  tags       = var.tags
  depends_on = [aws_iam_role_policy.logs, aws_iam_role_policy.vpc, aws_iam_role_policy.bootstrap_secret]
}
# Container images for the functions that run the DuckDB archive engine (D6). Tags are immutable
# so a deployed image never changes under a function; the Lambda service may pull from the
# repository only on behalf of this stack's functions. Nothing is pushed here: the operator builds
# the image with `errtraq build` and pushes it, then supplies image_uri.
resource "aws_ecr_repository" "image" {
  count                = length(local.image_functions) > 0 ? 1 : 0
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  encryption_configuration { encryption_type = "AES256" }
  image_scanning_configuration { scan_on_push = true }
  tags = var.tags
}
resource "aws_ecr_lifecycle_policy" "image" {
  count      = length(local.image_functions) > 0 ? 1 : 0
  repository = aws_ecr_repository.image[0].name
  policy = jsonencode({ rules = [{
    rulePriority = 1
    description  = "Keep the most recent images"
    selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = var.image_retention_count }
    action       = { type = "expire" }
  }] })
}
resource "aws_ecr_repository_policy" "image" {
  count      = length(local.image_functions) > 0 ? 1 : 0
  repository = aws_ecr_repository.image[0].name
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "LambdaPull"
    Effect    = "Allow"
    Principal = { Service = "lambda.amazonaws.com" }
    Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    Condition = { StringLike = { "aws:sourceArn" = "arn:${data.aws_partition.current[0].partition}:lambda:${data.aws_region.current[0].region}:${data.aws_caller_identity.current[0].account_id}:function:${var.name}-*" } }
  }] })
}
# Public URL is required for ordinary Sentry clients; request authentication is in the application.
resource "aws_lambda_function_url" "http" {
  for_each           = local.http_functions
  function_name      = aws_lambda_function.function[each.key].function_name
  authorization_type = each.value.auth_type
  dynamic "cors" {
    for_each = contains(each.value.http, "ingest") ? [1] : []
    content {
      allow_origins = ["*"]
      allow_methods = ["POST"]
      # Lowercase: AWS stores header names lowercased, so other casings drift on every plan.
      allow_headers  = ["content-type", "content-encoding", "x-sentry-auth", "x-requested-with", "sentry-trace", "baggage"]
      expose_headers = ["x-sentry-error", "x-sentry-rate-limits", "retry-after"]
    }
  }
  # Browser access to the API from another origin (a UI hosted elsewhere): exact origins only. The
  # application adds no CORS headers of its own on Lambda, so the response carries one policy.
  dynamic "cors" {
    for_each = !contains(each.value.http, "ingest") && contains(each.value.http, "api") && length(var.api_cors_origins) > 0 ? [1] : []
    content {
      allow_origins     = var.api_cors_origins
      allow_methods     = ["GET", "PUT", "POST"]
      allow_headers     = ["authorization", "content-type"]
      expose_headers    = ["link"]
      allow_credentials = false
      max_age           = 86400
    }
  }
}
resource "aws_lambda_permission" "url" {
  for_each               = local.public_functions
  statement_id           = "PublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.function[each.key].function_name
  principal              = "*"
  function_url_auth_type = each.value.auth_type
}
resource "aws_lambda_permission" "url_invoke" {
  for_each                 = local.public_functions
  statement_id             = "PublicInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.function[each.key].function_name
  principal                = "*"
  invoked_via_function_url = true
}
resource "aws_lambda_event_source_mapping" "queue" {
  for_each                = var.queue_triggers
  event_source_arn        = each.value.resource
  function_name           = aws_lambda_function.function[each.value.function_id].arn
  batch_size              = each.value.batch_size
  function_response_types = ["ReportBatchItemFailures"]
  dynamic "scaling_config" {
    for_each = each.value.max_concurrency == null ? [] : [each.value.max_concurrency]
    content { maximum_concurrency = scaling_config.value }
  }
  depends_on = [aws_iam_role_policy.capability]
  lifecycle {
    precondition {
      condition     = each.value.visibility_timeout_sec >= var.functions[each.value.function_id].timeout_sec
      error_message = "Queue visibility timeout must be at least the consumer function timeout."
    }
  }
}
resource "aws_cloudwatch_event_rule" "cron" {
  for_each            = var.cron_triggers
  name                = "${var.name}-${each.key}"
  schedule_expression = "cron(${local.cron[each.key][0]} ${local.cron[each.key][1]} ${local.cron[each.key][2] == "*" ? "?" : local.cron[each.key][2]} ${local.cron[each.key][3]} ${local.cron[each.key][2] == "*" ? "*" : "?"} *)"
  tags                = var.tags
}
resource "aws_cloudwatch_event_target" "cron" {
  for_each = var.cron_triggers
  rule     = aws_cloudwatch_event_rule.cron[each.key].name
  arn      = aws_lambda_function.function[each.value.function_id].arn
  input    = jsonencode({ job = each.key })
  retry_policy {
    maximum_retry_attempts       = each.value.retry_attempts
    maximum_event_age_in_seconds = each.value.max_event_age_seconds
  }
  dynamic "dead_letter_config" {
    for_each = each.value.dlq_arn == null ? [] : [each.value.dlq_arn]
    content { arn = dead_letter_config.value }
  }
}
resource "aws_lambda_permission" "cron" {
  for_each      = var.cron_triggers
  statement_id  = "EventBridge-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.function[each.value.function_id].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cron[each.key].arn
}
# Any invocation error in a five-minute window alarms; no invocations means no datapoints, which is healthy.
resource "aws_cloudwatch_metric_alarm" "errors" {
  for_each            = aws_lambda_function.function
  alarm_name          = "${var.name}-${each.key}-errors"
  alarm_description   = "The ${each.value.function_name} function reported invocation errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value.function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
  tags                = var.tags
}
# The web UI: a private bucket behind CloudFront that serves the build and forwards /api/0/* to the
# API function URL, so the UI and the API share one origin. Ingest keeps its own function URL (the
# DSN host) and is not routed through the distribution.
module "static_site" {
  count            = var.ui == null ? 0 : 1
  source           = "../static-site"
  name             = var.name
  tags             = var.tags
  api_origin_url   = local.role_urls.api
  assets_directory = "${dirname(dirname(var.ui.build_anchor))}/ui"
  price_class      = var.ui.price_class
}
