variable "name" {
  type        = string
  description = "Stack name used as the resource name prefix."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,19}$", var.name))
    error_message = "name must be 1-20 lowercase letters, digits or hyphens and start with a letter."
  }
}
variable "location" {
  type        = string
  description = "Bucket location (a region such as europe-west1). Required and never defaulted: it is immutable after creation."
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.location))
    error_message = "location must be a single region identifier such as europe-west1."
  }
}
variable "labels" {
  type        = map(string)
  description = "Labels applied to the bucket."
  default     = {}
  validation {
    condition     = alltrue([for key, value in var.labels : can(regex("^[a-z][a-z0-9_-]{0,62}$", key)) && can(regex("^[a-z0-9_-]{0,63}$", value))])
    error_message = "Label keys and values must follow GCP label rules (lowercase letters, digits, underscores, hyphens)."
  }
}
variable "protection" {
  type        = string
  description = "Production refuses to destroy a non-empty bucket; disposable permits teardown with its objects."
  default     = "production"
  validation {
    condition     = contains(["production", "disposable"], var.protection)
    error_message = "protection must be production or disposable."
  }
}
variable "raw_retention_days" {
  type        = number
  description = "Days before abandoned raw envelopes expire; size this for the maximum recovery window."
  default     = 14
  validation {
    condition     = var.raw_retention_days >= 1 && floor(var.raw_retention_days) == var.raw_retention_days
    error_message = "raw_retention_days must be a positive integer."
  }
}
variable "artifact_chunk_retention_days" {
  type        = number
  description = "Days before uploaded but never assembled sourcemap chunks under artifacts/chunks/ expire."
  default     = 7
  validation {
    condition     = var.artifact_chunk_retention_days >= 1 && floor(var.artifact_chunk_retention_days) == var.artifact_chunk_retention_days
    error_message = "artifact_chunk_retention_days must be a positive integer."
  }
}
variable "record_claim_retention_days" {
  type        = number
  description = "Days before grouped-record claim checks under payloads/records/ expire. Must exceed the longest Pub/Sub message retention (the pubsub module keeps 7 days), because a message redriven after expiry fails as poison."
  default     = 30
  validation {
    condition     = var.record_claim_retention_days >= 8 && floor(var.record_claim_retention_days) == var.record_claim_retention_days
    error_message = "record_claim_retention_days must be an integer of at least 8 (Pub/Sub retains messages for 7 days)."
  }
}
variable "max_event_retention_days" {
  type        = number
  description = "Longest per-project event retention in the stack. Overflow payload orphans never expire before this plus overflow_orphan_margin_days; projects must not be configured with a longer retention."
  default     = 30
  validation {
    condition     = var.max_event_retention_days >= 1 && floor(var.max_event_retention_days) == var.max_event_retention_days
    error_message = "max_event_retention_days must be a positive integer."
  }
}
variable "overflow_orphan_margin_days" {
  type        = number
  description = "Days added to max_event_retention_days before orphaned overflow payloads expire; covers clock skew, queue delay between receipt and payload write, and a late retention run."
  default     = 7
  validation {
    condition     = var.overflow_orphan_margin_days >= 1 && floor(var.overflow_orphan_margin_days) == var.overflow_orphan_margin_days
    error_message = "overflow_orphan_margin_days must be a positive integer."
  }
}
