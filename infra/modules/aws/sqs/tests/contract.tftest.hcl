mock_provider "aws" {}
run "queues_and_policies" {
  command = apply
  variables {
    name   = "example"
    region = "us-east-1"
    tags   = {}
    physical_queues = {
      ingest        = { visibility_timeout_sec = 180, dlq_enabled = true, max_receive_count = 5 }
      notifications = { visibility_timeout_sec = 270, dlq_enabled = false, max_receive_count = 3 }
    }
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["produce", "consume"]) && alltrue([for policies in values(output.policies) : toset(keys(policies)) == toset(keys(output.queues)) && alltrue([for policy in values(policies) : can(jsondecode(policy))])]) && alltrue([for queue in values(output.queues) : toset(keys(queue)) == toset(["arn", "url"])])
    error_message = "Queue and policy output shapes must match the descriptor."
  }
  assert {
    condition     = length(output.queues) == 2 && length(aws_sqs_queue.dlq) == 1 && aws_sqs_queue.queue["notifications"].visibility_timeout_seconds == 270
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
