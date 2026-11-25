variable "name" {
  type        = string
  description = "Stack name used as the topic name prefix."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,19}$", var.name))
    error_message = "name must be 1-20 lowercase letters, digits or hyphens and start with a letter."
  }
}
variable "project_id" {
  type        = string
  description = "Project that owns the topics. Required and never defaulted."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a GCP project id."
  }
}
variable "region" {
  type        = string
  description = "Region the topics persist messages in (message storage policy). Required and never defaulted; it must match the subscriptions' endpoint and the Cloud Run region."
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "region must be a GCP region identifier such as europe-west1."
  }
}
variable "labels" {
  type        = map(string)
  description = "Labels applied to topics and the dead-letter subscriptions."
  default     = {}
  validation {
    condition     = alltrue([for key, value in var.labels : can(regex("^[a-z][a-z0-9_-]{0,62}$", key)) && can(regex("^[a-z0-9_-]{0,63}$", value))])
    error_message = "Label keys and values must follow GCP label rules (lowercase letters, digits, underscores, hyphens)."
  }
}
variable "physical_queues" {
  type = map(object({
    ordered               = optional(bool, false)
    ack_deadline_sec      = number
    min_backoff_sec       = optional(number)
    max_backoff_sec       = optional(number)
    dlq_enabled           = bool
    max_delivery_attempts = optional(number, 5)
  }))
  description = "Physical queue settings keyed by shared or per-topic resource identifier. Subscriptions are created by the platform module under the reserved names this module outputs; the settings are validated here so one contract covers both."
  validation {
    condition = length(var.physical_queues) > 0 && alltrue([for key, queue in var.physical_queues :
      can(regex("^[a-zA-Z0-9_]{1,30}$", key)) &&
      queue.ack_deadline_sec >= 10 && queue.ack_deadline_sec <= 600 && floor(queue.ack_deadline_sec) == queue.ack_deadline_sec &&
      (queue.min_backoff_sec == null ? true : queue.min_backoff_sec >= 0 && queue.min_backoff_sec <= 600) &&
      (queue.max_backoff_sec == null ? true : queue.max_backoff_sec >= 0 && queue.max_backoff_sec <= 600) &&
      (queue.min_backoff_sec == null || queue.max_backoff_sec == null ? true : queue.min_backoff_sec <= queue.max_backoff_sec) &&
      queue.max_delivery_attempts >= 5 && queue.max_delivery_attempts <= 100 && floor(queue.max_delivery_attempts) == queue.max_delivery_attempts
    ])
    error_message = "Queues need identifier keys, an ack deadline of 10-600 seconds, backoffs of 0-600 seconds (minimum not above maximum) and 5-100 delivery attempts."
  }
}
