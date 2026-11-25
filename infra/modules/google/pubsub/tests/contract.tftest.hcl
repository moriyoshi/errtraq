mock_provider "google" {}
run "queues_and_policies" {
  command = apply
  variables {
    name       = "example"
    project_id = "example-project"
    region     = "europe-west1"
    physical_queues = {
      shared = { ack_deadline_sec = 180, min_backoff_sec = 10, max_backoff_sec = 600, dlq_enabled = true, max_delivery_attempts = 5 }
      record = { ordered = true, ack_deadline_sec = 180, dlq_enabled = true, max_delivery_attempts = 5 }
      plain  = { ack_deadline_sec = 60, dlq_enabled = false }
    }
  }
  assert {
    condition = jsonencode(output.queues) == jsonencode({
      plain  = { topic = "projects/example-project/topics/example-plain", subscription = "projects/example-project/subscriptions/example-plain", dlq_topic = "", dlq_subscription = "" }
      record = { topic = "projects/example-project/topics/example-record", subscription = "projects/example-project/subscriptions/example-record", dlq_topic = "projects/example-project/topics/example-record-dlq", dlq_subscription = "projects/example-project/subscriptions/example-record-dlq" }
      shared = { topic = "projects/example-project/topics/example-shared", subscription = "projects/example-project/subscriptions/example-shared", dlq_topic = "projects/example-project/topics/example-shared-dlq", dlq_subscription = "projects/example-project/subscriptions/example-shared-dlq" }
    })
    error_message = "Topics are <name>-<physical>, dead-letter topics <name>-<physical>-dlq, and the subscription name is reserved as <name>-<physical>."
  }
  assert {
    condition     = toset(keys(google_pubsub_topic.dlq)) == toset(["shared", "record"]) && toset(keys(google_pubsub_subscription.dlq)) == toset(["shared", "record"])
    error_message = "Dead-letter topics and their retaining subscriptions exist exactly for queues with a DLQ."
  }
  assert {
    condition     = alltrue([for subscription in values(google_pubsub_subscription.dlq) : subscription.expiration_policy[0].ttl == "" && subscription.message_retention_duration == "1209600s"])
    error_message = "The dead-letter subscription must never expire and keep messages for 14 days."
  }
  assert {
    condition     = alltrue([for topic in concat(values(google_pubsub_topic.queue), values(google_pubsub_topic.dlq)) : toset(topic.message_storage_policy[0].allowed_persistence_regions) == toset(["europe-west1"])])
    error_message = "Messages persist only in the explicit region."
  }
  assert {
    condition = alltrue([for key in ["shared", "record", "plain"] :
      jsonencode(jsondecode(output.policies.produce[key])) == jsonencode([{ role = "roles/pubsub.publisher", resource = "projects/example-project/topics/example-${key}" }]) &&
      length(jsondecode(output.policies.consume[key])) == 0
    ])
    error_message = "Producers publish on exactly the physical topic; consumers need no binding because push uses run.invoker."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["produce", "consume"]) && alltrue([for policies in values(output.policies) : toset(keys(policies)) == toset(["shared", "record", "plain"])])
    error_message = "Policy output shape must follow the descriptor."
  }
}
run "reject_low_delivery_attempts" {
  command = plan
  variables {
    name            = "example"
    project_id      = "example-project"
    region          = "europe-west1"
    physical_queues = { shared = { ack_deadline_sec = 180, dlq_enabled = true, max_delivery_attempts = 4 } }
  }
  expect_failures = [var.physical_queues]
}
run "reject_missing_region" {
  command = plan
  variables {
    name            = "example"
    project_id      = "example-project"
    region          = "europe"
    physical_queues = { shared = { ack_deadline_sec = 180, dlq_enabled = false } }
  }
  expect_failures = [var.region]
}
run "reject_unordered_backoff" {
  command = plan
  variables {
    name            = "example"
    project_id      = "example-project"
    region          = "europe-west1"
    physical_queues = { shared = { ack_deadline_sec = 180, min_backoff_sec = 100, max_backoff_sec = 10, dlq_enabled = false } }
  }
  expect_failures = [var.physical_queues]
}
run "reject_ack_deadline_over_600" {
  command = plan
  variables {
    name            = "example"
    project_id      = "example-project"
    region          = "europe-west1"
    physical_queues = { shared = { ack_deadline_sec = 601, dlq_enabled = false } }
  }
  expect_failures = [var.physical_queues]
}
