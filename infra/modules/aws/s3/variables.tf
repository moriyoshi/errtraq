variable "name" {
  type        = string
  description = "Stack name used as the resource name prefix."
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$", var.name))
    error_message = "name must contain 1-40 letters, digits, or hyphens and start with a letter or digit."
  }
}
variable "tags" {
  type        = map(string)
  description = "Tags applied to supported resources."
  validation {
    condition     = alltrue([for key in keys(var.tags) : length(key) > 0 && length(key) <= 128 && !startswith(lower(key), "aws:")])
    error_message = "Tag keys must be nonempty, at most 128 characters, and not start with aws:."
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
  description = "Days before grouped-record claim checks under payloads/records/ expire. Must exceed SQS's 14-day maximum retention, because a message redriven after expiry fails as poison."
  default     = 30
  validation {
    condition     = var.record_claim_retention_days >= 15 && floor(var.record_claim_retention_days) == var.record_claim_retention_days
    error_message = "record_claim_retention_days must be an integer of at least 15 (SQS retains messages for up to 14 days)."
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

variable "protection" {
  type        = string
  description = "Production prevents resource destruction; disposable permits teardown."
  default     = "production"
  validation {
    condition     = contains(["production", "disposable"], var.protection)
    error_message = "protection must be production or disposable."
  }
}
