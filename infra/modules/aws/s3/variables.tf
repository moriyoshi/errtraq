variable "name" {
  type        = string
  description = "Stack name used as the resource name prefix."
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$", var.name))
    error_message = "name must contain 1-40 letters, digits, or hyphens and start with a letter or digit."
  }
}
variable "region" {
  type        = string
  description = "AWS region selected by the stack provider."
  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.region))
    error_message = "region must be an AWS region identifier."
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
variable "staging_prefix" {
  type        = string
  description = "Prefix for temporary archival write-ahead objects."
  validation {
    condition     = can(regex("^[a-zA-Z0-9_-]+/$", var.staging_prefix)) && !contains(["envelopes/", "payloads/", "artifacts/"], var.staging_prefix)
    error_message = "staging_prefix must be a distinct simple prefix ending in /."
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
variable "staging_retention_days" {
  type        = number
  description = "Days before abandoned archive staging objects expire."
  default     = 7
  validation {
    condition     = var.staging_retention_days >= 1 && floor(var.staging_retention_days) == var.staging_retention_days
    error_message = "staging_retention_days must be a positive integer."
  }
}
