locals {
  queues_with_dlq = { for key, queue in var.physical_queues : key => queue if queue.dlq_enabled }
}
# Naming contract shared with the platform module, which derives names from the subscription name:
#   topic              <name>-<physical>
#   dead-letter topic  <name>-<physical>-dlq
#   subscription       <name>-<physical>   (reserved here, created by the platform module)
resource "google_pubsub_topic" "queue" {
  for_each = var.physical_queues
  project  = var.project_id
  name     = "${var.name}-${each.key}"
  labels   = var.labels
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
}
resource "google_pubsub_topic" "dlq" {
  for_each = local.queues_with_dlq
  project  = var.project_id
  name     = "${var.name}-${each.key}-dlq"
  labels   = var.labels
  message_storage_policy {
    allowed_persistence_regions = [var.region]
  }
}
# The dead-letter topic retains messages in a pull subscription so an operator can inspect and redrive
# them; without it dead-lettered messages would be dropped. Messages are kept for 14 days and the
# subscription never expires on inactivity.
resource "google_pubsub_subscription" "dlq" {
  for_each                   = local.queues_with_dlq
  project                    = var.project_id
  name                       = "${var.name}-${each.key}-dlq"
  topic                      = google_pubsub_topic.dlq[each.key].id
  labels                     = var.labels
  ack_deadline_seconds       = 60
  message_retention_duration = "1209600s"
  expiration_policy {
    ttl = ""
  }
}
locals {
  queues = {
    for key, topic in google_pubsub_topic.queue : key => {
      topic = "projects/${topic.project}/topics/${topic.name}"
      # Reserved, not created: the platform module creates the push subscription under this name.
      subscription     = "projects/${topic.project}/subscriptions/${topic.name}"
      dlq_topic        = contains(keys(local.queues_with_dlq), key) ? "projects/${google_pubsub_topic.dlq[key].project}/topics/${google_pubsub_topic.dlq[key].name}" : ""
      dlq_subscription = contains(keys(local.queues_with_dlq), key) ? "projects/${google_pubsub_subscription.dlq[key].project}/subscriptions/${google_pubsub_subscription.dlq[key].name}" : ""
    }
  }
  policies = {
    # Publishing is bound on the physical topic. A push consumer needs no binding of its own: the
    # push service account holds run.invoker on the function's service instead.
    produce = { for key, queue in local.queues : key => jsonencode([{ role = "roles/pubsub.publisher", resource = queue.topic }]) }
    consume = { for key, queue in local.queues : key => jsonencode([]) }
  }
}
