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
variable "log_retention_days" {
  type        = number
  description = "CloudWatch log group retention in days."
  default     = 30
  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch-supported retention period."
  }
}
variable "functions" {
  description = "Physical functions, scoped bindings, policies and build-produced ZIP artifacts."
  type = map(object({
    roles                = list(string)
    http                 = list(string)
    artifact             = string
    memory_mb            = number
    timeout_sec          = number
    architecture         = string
    auth_type            = optional(string, "NONE")
    reserved_concurrency = optional(number)
    environment          = map(string)
    secrets              = map(string)
    policies             = list(string)
    secret_reads         = list(string)
  }))
  validation {
    condition = alltrue([for id, fn in var.functions :
      can(regex("^[a-zA-Z0-9_-]{1,23}$", id)) &&
      length(fn.roles) > 0 && alltrue([for role in fn.roles : contains(["ingest", "api", "consumer", "cron"], role)]) &&
      alltrue([for role in fn.http : contains(["ingest", "api"], role) && contains(fn.roles, role)]) &&
      fn.memory_mb >= 128 && fn.memory_mb <= 10240 && floor(fn.memory_mb) == fn.memory_mb &&
      fn.timeout_sec >= 1 && fn.timeout_sec <= 900 && floor(fn.timeout_sec) == fn.timeout_sec &&
      contains(["x86_64", "arm64"], fn.architecture) && length(fn.artifact) > 0 &&
      contains(["NONE", "AWS_IAM"], fn.auth_type) &&
      (fn.reserved_concurrency == null ? true : fn.reserved_concurrency >= 0 && floor(fn.reserved_concurrency) == fn.reserved_concurrency) &&
      length(setintersection(toset(keys(fn.environment)), toset(keys(fn.secrets)))) == 0 &&
      alltrue([for secret in fn.secret_reads : can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+", secret))]) &&
      alltrue([for secret in values(fn.secrets) : contains(fn.secret_reads, secret)])
    ])
    error_message = "Functions must have valid roles, limits, artifact, distinct bindings and Secrets Manager ARN read grants."
  }
  validation {
    condition     = alltrue([for role in ["ingest", "api"] : length([for fn in values(var.functions) : fn if contains(fn.http, role)]) <= 1])
    error_message = "Each HTTP role may be exposed by at most one function."
  }
}
variable "queue_triggers" {
  description = "Physical queue triggers keyed by queue identifier."
  type = map(object({
    function_id            = string
    resource               = string
    topics                 = list(string)
    batch_size             = optional(number, 10)
    max_concurrency        = optional(number)
    visibility_timeout_sec = number
  }))
  validation {
    condition = alltrue([for trigger in values(var.queue_triggers) :
      contains(keys(var.functions), trigger.function_id) &&
      can(regex("^arn:[^:]+:sqs:", trigger.resource)) &&
      trigger.visibility_timeout_sec >= 1 && trigger.visibility_timeout_sec <= 43200 && floor(trigger.visibility_timeout_sec) == trigger.visibility_timeout_sec &&
      trigger.batch_size >= 1 && trigger.batch_size <= 10 && floor(trigger.batch_size) == trigger.batch_size &&
      (trigger.max_concurrency == null ? true : trigger.max_concurrency >= 2 && trigger.max_concurrency <= 1000 && floor(trigger.max_concurrency) == trigger.max_concurrency)
    ])
    error_message = "Queue triggers must target a function and SQS ARN with valid batch and concurrency limits."
  }
}
variable "cron_triggers" {
  description = "Five-field UTC cron schedules keyed by job name."
  type = map(object({
    function_id           = string
    schedule              = string
    retry_attempts        = optional(number, 185)
    max_event_age_seconds = optional(number, 86400)
    dlq_arn               = optional(string)
  }))
  validation {
    condition = alltrue([for job, trigger in var.cron_triggers :
      can(regex("^[a-zA-Z0-9_-]{1,23}$", job)) && contains(keys(var.functions), trigger.function_id) &&
      trigger.retry_attempts >= 0 && trigger.retry_attempts <= 185 && floor(trigger.retry_attempts) == trigger.retry_attempts &&
      trigger.max_event_age_seconds >= 60 && trigger.max_event_age_seconds <= 86400 && floor(trigger.max_event_age_seconds) == trigger.max_event_age_seconds &&
      (trigger.dlq_arn == null ? true : can(regex("^arn:[^:]+:sqs:", trigger.dlq_arn))) &&
      length(split(" ", trigger.schedule)) == 5 &&
      try(split(" ", trigger.schedule)[4] == "*", false)
    ])
    error_message = "Cron jobs need a function, five fields with day-of-week set to * (Unix weekday numbering differs from EventBridge)."
  }
}

variable "runtime" {
  type        = string
  description = "Lambda runtime compatible with the built handler."
  default     = "nodejs22.x"
  validation {
    condition     = can(regex("^[a-zA-Z0-9.]+$", var.runtime))
    error_message = "runtime must be a Lambda runtime identifier."
  }
}
variable "handler" {
  type        = string
  description = "Lambda handler exported by the artifact."
  default     = "index.handler"
  validation {
    condition     = can(regex("^[a-zA-Z0-9_./-]+$", var.handler))
    error_message = "handler must be a Lambda handler identifier."
  }
}

variable "vpc_subnet_ids" {
  type        = list(string)
  description = "Existing subnet IDs for Lambda VPC access; provide with security groups."
  default     = []
  validation {
    condition     = length(var.vpc_subnet_ids) <= 16 && alltrue([for id in var.vpc_subnet_ids : can(regex("^subnet-([a-f0-9]{8}|[a-f0-9]{17})$", id))])
    error_message = "Provide up to 16 valid subnet IDs."
  }
}
variable "vpc_security_group_ids" {
  type        = list(string)
  description = "Existing security group IDs for Lambda VPC access; provide with subnets."
  default     = []
  validation {
    condition     = length(var.vpc_security_group_ids) <= 5 && alltrue([for id in var.vpc_security_group_ids : can(regex("^sg-([a-f0-9]{8}|[a-f0-9]{17})$", id))])
    error_message = "Provide up to five valid security group IDs."
  }
}
