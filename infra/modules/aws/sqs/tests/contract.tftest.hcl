mock_provider "aws" {}
run "queues_and_policies" {
  command = apply
  variables {
    name = "example"

    tags = {}
    physical_queues = {
      ingest          = { visibility_timeout_sec = 180, dlq_enabled = true, max_receive_count = 5 }
      notifications   = { visibility_timeout_sec = 270, dlq_enabled = false, max_receive_count = 3 }
      archive_project = { visibility_timeout_sec = 180, dlq_enabled = false, max_receive_count = 5 }
      shared          = { visibility_timeout_sec = 180, dlq_enabled = false, max_receive_count = 5 }
    }
  }
  assert {
    condition     = alltrue([for key, queue in aws_sqs_queue.queue : jsonencode(jsondecode(output.policies.produce[key])) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["sqs:SendMessage"], Resource = queue.arn }] }) && jsonencode(jsondecode(output.policies.consume[key])) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], Resource = queue.arn }] })])
    error_message = "Every SQS policy must have exactly the intended actions and queue ARN."
  }
  assert {
    condition     = alltrue([for queue in values(aws_sqs_queue.queue) : queue.sqs_managed_sse_enabled && queue.max_message_size == 1048576]) && alltrue([for queue in values(aws_sqs_queue.dlq) : queue.sqs_managed_sse_enabled]) && jsondecode(aws_sqs_queue.queue["ingest"].redrive_policy).maxReceiveCount == 5 && jsondecode(aws_sqs_queue.queue["ingest"].redrive_policy).deadLetterTargetArn == aws_sqs_queue.dlq["ingest"].arn && !contains(keys(aws_sqs_queue.dlq), "notifications")
    error_message = "SQS encryption, message size and exact redrive settings must be preserved."
  }
  assert {
    condition     = alltrue(flatten([for resources in values(output.policies) : [for policy in values(resources) : length(policy) <= 1024]]))
    error_message = "Current per-resource policies must fit the 1024-character sizing budget."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["produce", "consume"]) && alltrue([for policies in values(output.policies) : toset(keys(policies)) == toset(keys(output.queues)) && alltrue([for policy in values(policies) : can(jsondecode(policy))])]) && alltrue([for queue in values(output.queues) : toset(keys(queue)) == toset(["arn", "url"])])
    error_message = "Queue and policy output shapes must match the descriptor."
  }
  assert {
    condition     = aws_sqs_queue.queue["ingest"].message_retention_seconds == 345600 && aws_sqs_queue.dlq["ingest"].message_retention_seconds == 1209600
    error_message = "SQS source and DLQ retention must be explicit."
  }
  assert {
    condition     = length(output.queues) == 4 && length(aws_sqs_queue.dlq) == 1 && aws_sqs_queue.queue["notifications"].visibility_timeout_seconds == 270
    error_message = "Each physical queue must retain its own configuration."
  }
  assert {
    condition     = jsondecode(output.policies.produce.ingest).Statement[0].Resource == aws_sqs_queue.queue["ingest"].arn && !contains(jsondecode(output.policies.produce.ingest).Statement[0].Action, "sqs:ReceiveMessage")
    error_message = "Producer access must be limited to the selected queue and send."
  }
  assert {
    condition     = contains(jsondecode(output.policies.consume.notifications).Statement[0].Action, "sqs:ChangeMessageVisibility") && jsondecode(output.policies.consume.notifications).Statement[0].Resource == aws_sqs_queue.queue["notifications"].arn
    error_message = "Consumer access must include retries and target only its queue."
  }
}
