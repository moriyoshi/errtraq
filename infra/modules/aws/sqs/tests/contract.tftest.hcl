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
      record          = { visibility_timeout_sec = 180, dlq_enabled = true, max_receive_count = 5, fifo = true }
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
    condition     = length(output.queues) == 5 && length(aws_sqs_queue.dlq) == 2 && aws_sqs_queue.queue["notifications"].visibility_timeout_seconds == 270
    error_message = "Each physical queue must retain its own configuration."
  }
  assert {
    condition     = aws_sqs_queue.queue["record"].name == "example-record.fifo" && aws_sqs_queue.queue["record"].fifo_queue && !aws_sqs_queue.queue["record"].content_based_deduplication && aws_sqs_queue.queue["record"].deduplication_scope == "messageGroup" && aws_sqs_queue.queue["record"].fifo_throughput_limit == "perMessageGroupId" && aws_sqs_queue.dlq["record"].name == "example-record-dlq.fifo" && aws_sqs_queue.dlq["record"].fifo_queue && jsondecode(aws_sqs_queue.queue["record"].redrive_policy).deadLetterTargetArn == aws_sqs_queue.dlq["record"].arn
    error_message = "The record queue and its DLQ must be FIFO with explicit deduplication and high-throughput settings."
  }
  assert {
    condition     = jsondecode(output.policies.produce.ingest).Statement[0].Resource == aws_sqs_queue.queue["ingest"].arn && !contains(jsondecode(output.policies.produce.ingest).Statement[0].Action, "sqs:ReceiveMessage")
    error_message = "Producer access must be limited to the selected queue and send."
  }
  assert {
    condition     = contains(jsondecode(output.policies.consume.notifications).Statement[0].Action, "sqs:ChangeMessageVisibility") && jsondecode(output.policies.consume.notifications).Statement[0].Resource == aws_sqs_queue.queue["notifications"].arn
    error_message = "Consumer access must include retries and target only its queue."
  }
  assert {
    condition = length(aws_cloudwatch_metric_alarm.dlq_messages) == 2 && toset(keys(aws_cloudwatch_metric_alarm.dlq_messages)) == toset(["ingest", "record"]) && alltrue([for key, alarm in aws_cloudwatch_metric_alarm.dlq_messages :
      alarm.namespace == "AWS/SQS" && alarm.metric_name == "ApproximateNumberOfMessagesVisible" && alarm.statistic == "Maximum" && alarm.period == 300 && alarm.evaluation_periods == 1 && alarm.datapoints_to_alarm == 1 &&
      alarm.threshold == 0 && alarm.comparison_operator == "GreaterThanThreshold" && alarm.treat_missing_data == "notBreaching" && jsonencode(alarm.dimensions) == jsonencode({ QueueName = aws_sqs_queue.dlq[key].name }) && alarm.alarm_name == "example-${key}-dlq-messages"
    ])
    error_message = "Every enabled DLQ, and only those, needs an exact visible-messages alarm."
  }
  assert {
    condition     = jsonencode(aws_cloudwatch_metric_alarm.dlq_messages["record"].dimensions) == jsonencode({ QueueName = "example-record-dlq.fifo" }) && jsonencode(aws_cloudwatch_metric_alarm.queue_age["record"].dimensions) == jsonencode({ QueueName = "example-record.fifo" }) && jsonencode(aws_cloudwatch_metric_alarm.queue_age["ingest"].dimensions) == jsonencode({ QueueName = "example-ingest" })
    error_message = "Alarm dimensions must be the actual queue names including the FIFO suffix."
  }
  assert {
    condition = length(aws_cloudwatch_metric_alarm.queue_age) == 5 && toset(keys(aws_cloudwatch_metric_alarm.queue_age)) == toset(keys(aws_sqs_queue.queue)) && alltrue([for key, alarm in aws_cloudwatch_metric_alarm.queue_age :
      alarm.namespace == "AWS/SQS" && alarm.metric_name == "ApproximateAgeOfOldestMessage" && alarm.statistic == "Maximum" && alarm.period == 300 && alarm.evaluation_periods == 3 && alarm.datapoints_to_alarm == 3 &&
      alarm.threshold == 900 && alarm.comparison_operator == "GreaterThanThreshold" && alarm.treat_missing_data == "notBreaching" && alarm.alarm_name == "example-${key}-queue-age"
    ])
    error_message = "Every physical source queue needs exactly one exact queue-age alarm."
  }
  assert {
    condition     = alltrue([for alarm in concat(values(aws_cloudwatch_metric_alarm.dlq_messages), values(aws_cloudwatch_metric_alarm.queue_age)) : length(alarm.alarm_actions) == 0 && alarm.ok_actions == null && alarm.insufficient_data_actions == null])
    error_message = "Without an operator topic no alarm may have any action."
  }
}
run "alarm_actions_and_tags" {
  command = apply
  variables {
    name            = "example"
    tags            = { stack = "example" }
    alarm_topic_arn = "arn:aws:sns:us-east-1:000000000000:operators"
    physical_queues = {
      shared = { visibility_timeout_sec = 180, dlq_enabled = false, max_receive_count = 5 }
    }
  }
  assert {
    condition     = length(aws_cloudwatch_metric_alarm.dlq_messages) == 0 && length(aws_cloudwatch_metric_alarm.queue_age) == 1 && aws_cloudwatch_metric_alarm.queue_age["shared"].alarm_actions == toset(["arn:aws:sns:us-east-1:000000000000:operators"]) && jsonencode(aws_cloudwatch_metric_alarm.queue_age["shared"].tags) == jsonencode({ stack = "example" })
    error_message = "A queue without a DLQ gets only an age alarm; the operator topic and stack tags must be applied."
  }
}
run "alarm_actions_on_dlq" {
  command = apply
  variables {
    name            = "example"
    tags            = { stack = "example" }
    alarm_topic_arn = "arn:aws:sns:us-east-1:000000000000:operators"
    physical_queues = {
      ingest = { visibility_timeout_sec = 180, dlq_enabled = true, max_receive_count = 5 }
    }
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_messages["ingest"].alarm_actions == toset(["arn:aws:sns:us-east-1:000000000000:operators"]) && aws_cloudwatch_metric_alarm.queue_age["ingest"].alarm_actions == toset(["arn:aws:sns:us-east-1:000000000000:operators"]) && jsonencode(aws_cloudwatch_metric_alarm.dlq_messages["ingest"].tags) == jsonencode({ stack = "example" }) && jsonencode(aws_cloudwatch_metric_alarm.queue_age["ingest"].tags) == jsonencode({ stack = "example" })
    error_message = "Both alarm kinds must notify the operator topic and carry the stack tags."
  }
}
run "invalid_alarm_topic" {
  command = plan
  variables {
    name            = "example"
    tags            = {}
    alarm_topic_arn = "arn:aws:sqs:us-east-1:000000000000:operators"
    physical_queues = {
      shared = { visibility_timeout_sec = 180, dlq_enabled = false, max_receive_count = 5 }
    }
  }
  expect_failures = [var.alarm_topic_arn]
}
