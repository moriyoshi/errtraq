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
variable "purpose" {
  type        = string
  description = "Whether this table serves the active store or KV port."
  validation {
    condition     = contains(["store", "kv"], var.purpose)
    error_message = "purpose must be store or kv."
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
