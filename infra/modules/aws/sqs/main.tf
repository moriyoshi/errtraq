resource "aws_sqs_queue" "dlq" {
  for_each                  = { for key, queue in var.physical_queues : key => queue if queue.dlq_enabled }
  name                      = "${var.name}-${each.key}-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
  tags                      = var.tags
}
resource "aws_sqs_queue" "queue" {
  for_each                   = var.physical_queues
  name                       = "${var.name}-${each.key}"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = each.value.visibility_timeout_sec
  max_message_size           = 1048576
  redrive_policy             = each.value.dlq_enabled ? jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn, maxReceiveCount = each.value.max_receive_count }) : null
  tags                       = var.tags
}
locals {
  queues = { for key, queue in aws_sqs_queue.queue : key => { arn = queue.arn, url = queue.url } }
  policies = {
    produce = { for key, queue in aws_sqs_queue.queue : key => jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = queue.arn }] }) }
    consume = { for key, queue in aws_sqs_queue.queue : key => jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], Resource = queue.arn }] }) }
  }
}
