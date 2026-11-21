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
variable "physical_queues" {
  type = map(object({
    fifo                   = optional(bool, false)
    visibility_timeout_sec = number
    dlq_enabled            = bool
    max_receive_count      = number
  }))
  description = "Physical queue settings keyed by shared or per-topic resource identifier."
  validation {
    condition = length(var.physical_queues) > 0 && alltrue([for key, queue in var.physical_queues :
      can(regex("^[a-zA-Z0-9_]{1,30}$", key)) &&
      queue.visibility_timeout_sec >= 1 && queue.visibility_timeout_sec <= 43200 && floor(queue.visibility_timeout_sec) == queue.visibility_timeout_sec &&
      queue.max_receive_count >= 1 && queue.max_receive_count <= 1000 && floor(queue.max_receive_count) == queue.max_receive_count
    ])
    error_message = "Queues need identifier keys and valid integer visibility and redrive settings."
  }
}
