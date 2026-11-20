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
variable "purpose" {
  type        = string
  description = "Whether this table serves the active store or KV port."
  validation {
    condition     = contains(["store", "kv"], var.purpose)
    error_message = "purpose must be store or kv."
  }
}
variable "deletion_protection" {
  type        = bool
  description = "Protect the table from accidental deletion."
  default     = true
  validation {
    condition     = var.deletion_protection == true || var.deletion_protection == false
    error_message = "deletion_protection must be a boolean."
  }
}
