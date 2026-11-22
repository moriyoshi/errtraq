resource "aws_sqs_queue" "dlq" {
  for_each                    = { for key, queue in var.physical_queues : key => queue if queue.dlq_enabled }
  name                        = "${var.name}-${each.key}-dlq${each.value.fifo ? ".fifo" : ""}"
  fifo_queue                  = each.value.fifo
  content_based_deduplication = each.value.fifo ? false : null
  sqs_managed_sse_enabled     = true
  message_retention_seconds   = 1209600
  tags                        = var.tags
}
resource "aws_sqs_queue" "queue" {
  for_each                    = var.physical_queues
  name                        = "${var.name}-${each.key}${each.value.fifo ? ".fifo" : ""}"
  fifo_queue                  = each.value.fifo
  content_based_deduplication = each.value.fifo ? false : null
  deduplication_scope         = each.value.fifo ? "messageGroup" : null
  fifo_throughput_limit       = each.value.fifo ? "perMessageGroupId" : null
  sqs_managed_sse_enabled     = true
  visibility_timeout_seconds  = each.value.visibility_timeout_sec
  message_retention_seconds   = 345600
  max_message_size            = 1048576
  redrive_policy              = each.value.dlq_enabled ? jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn, maxReceiveCount = each.value.max_receive_count }) : null
  tags                        = var.tags
}
locals {
  queues = { for key, queue in aws_sqs_queue.queue : key => { arn = queue.arn, url = queue.url } }
  policies = {
    produce = { for key, queue in aws_sqs_queue.queue : key => jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = queue.arn }] }) }
    consume = { for key, queue in aws_sqs_queue.queue : key => jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], Resource = queue.arn }] }) }
  }
}
# Alarms. SQS publishes no datapoints for an idle queue, so missing data is treated as not breaching.
locals {
  alarm_actions = var.alarm_topic_arn == null ? [] : [var.alarm_topic_arn]
}
# Any visible DLQ message means a message exhausted its receives and needs operator attention.
resource "aws_cloudwatch_metric_alarm" "dlq_messages" {
  for_each            = aws_sqs_queue.dlq
  alarm_name          = "${var.name}-${each.key}-dlq-messages"
  alarm_description   = "Messages are visible in the ${each.value.name} dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  tags                = var.tags
}
# The oldest message staying over 15 minutes for 15 minutes (three periods) means the consumer is stuck or throttled.
# A poison message that reaches the default redrive (5 receives x 180 s) is gone before this fires.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each            = aws_sqs_queue.queue
  alarm_name          = "${var.name}-${each.key}-queue-age"
  alarm_description   = "The oldest message in ${each.value.name} has waited more than 15 minutes."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = each.value.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  tags                = var.tags
}
