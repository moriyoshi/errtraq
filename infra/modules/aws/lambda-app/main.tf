locals {
  http_functions   = { for id, fn in var.functions : id => fn if length(fn.http) > 0 }
  role_urls        = { for role in ["ingest", "api"] : role => length([for fn in values(local.http_functions) : fn if contains(fn.http, role)]) > 0 ? one([for id, fn in local.http_functions : aws_lambda_function_url.http[id].function_url if contains(fn.http, role)]) : "" }
  policies         = { for item in flatten([for id, fn in var.functions : [for index, policy in fn.policies : { key = "${id}-${index}", id = id, policy = policy }]]) : item.key => item }
  secret_functions = { for id, fn in var.functions : id => fn if length(fn.secret_reads) > 0 }
  # Core emits standard five-field cron; EventBridge requires six fields and ? in one day field.
  cron = { for job, trigger in var.cron_triggers : job => split(" ", trigger.schedule) }
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
resource "aws_iam_role" "function" {
  for_each           = var.functions
  name               = "${var.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
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
resource "aws_lambda_function" "function" {
  for_each         = var.functions
  function_name    = "${var.name}-${each.key}"
  role             = aws_iam_role.function[each.key].arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = each.value.artifact
  source_code_hash = filebase64sha256(each.value.artifact)
  memory_size      = each.value.memory_mb
  timeout          = each.value.timeout_sec
  architectures    = [each.value.architecture]
  environment { variables = merge(each.value.environment, each.value.secrets) }
  tags       = var.tags
  depends_on = [aws_iam_role_policy.logs]
}
# Public URL is required for ordinary Sentry clients; request authentication is in the application.
resource "aws_lambda_function_url" "http" {
  for_each           = local.http_functions
  function_name      = aws_lambda_function.function[each.key].function_name
  authorization_type = "NONE"
}
resource "aws_lambda_permission" "url" {
  for_each               = local.http_functions
  statement_id           = "PublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.function[each.key].function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}
resource "aws_lambda_permission" "url_invoke" {
  for_each                 = local.http_functions
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
}
resource "aws_lambda_permission" "cron" {
  for_each      = var.cron_triggers
  statement_id  = "EventBridge-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.function[each.value.function_id].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.cron[each.key].arn
}
