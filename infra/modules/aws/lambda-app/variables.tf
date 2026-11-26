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
variable "artifact_bucket" {
  description = "Optional operator-owned S3 bucket in the Lambda region for ZIP deployments; null uses direct upload."
  type        = string
  default     = null
  validation {
    condition     = var.artifact_bucket == null ? true : can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.artifact_bucket))
    error_message = "artifact_bucket must be a valid lowercase S3 bucket name."
  }
}
variable "functions" {
  description = "Physical functions, scoped bindings, policies and build-produced artifacts: a ZIP, or for package_type Image the bundle inside the container image named by image_uri."
  type = map(object({
    roles                = list(string)
    http                 = list(string)
    artifact             = string
    package_type         = optional(string, "Zip")
    ephemeral_storage_mb = optional(number, 512)
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
      length(fn.roles) > 0 && alltrue([for role in fn.roles : contains(["ingest", "api", "consumer", "record", "cron", "archive", "bootstrap"], role)]) &&
      contains(["Zip", "Image"], fn.package_type) &&
      fn.ephemeral_storage_mb >= 512 && fn.ephemeral_storage_mb <= 10240 && floor(fn.ephemeral_storage_mb) == fn.ephemeral_storage_mb &&
      alltrue([for role in fn.http : contains(["ingest", "api"], role) && contains(fn.roles, role)]) &&
      fn.memory_mb >= 128 && fn.memory_mb <= 10240 && floor(fn.memory_mb) == fn.memory_mb &&
      fn.timeout_sec >= 1 && fn.timeout_sec <= 900 && floor(fn.timeout_sec) == fn.timeout_sec &&
      contains(["x86_64", "arm64"], fn.architecture) && length(fn.artifact) > 0 &&
      contains(["NONE", "AWS_IAM"], fn.auth_type) &&
      (fn.reserved_concurrency == null ? true : fn.reserved_concurrency >= 0 && floor(fn.reserved_concurrency) == fn.reserved_concurrency) &&
      length(setintersection(toset(keys(fn.environment)), toset(keys(fn.secrets)))) == 0 &&
      alltrue([for secret in fn.secret_reads : can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+", secret))]) &&
      alltrue([for secret in values(fn.secrets) : contains(fn.secret_reads, secret)]) &&
      # The bootstrap role is operator-invoked only: its own function, never exposed or triggered.
      (!contains(fn.roles, "bootstrap") || (length(fn.roles) == 1 && length(fn.http) == 0 && !contains(keys(fn.environment), "ERRTRAQ_BOOTSTRAP_SECRET_NAME") && !contains(keys(fn.secrets), "ERRTRAQ_BOOTSTRAP_SECRET_NAME"))) &&
      # The archive role is its own container-image function (D6): it loads the DuckDB engine, has no URL and
      # is reached only by its queue and its EventBridge schedules.
      (!contains(fn.roles, "archive") || (length(fn.roles) == 1 && fn.package_type == "Image" && length(fn.http) == 0))
    ])
    error_message = "Functions must have valid roles, limits, artifact, distinct bindings and Secrets Manager ARN read grants."
  }
  validation {
    condition     = alltrue([for role in ["ingest", "api"] : length([for fn in values(var.functions) : fn if contains(fn.http, role)]) <= 1])
    error_message = "Each HTTP role may be exposed by at most one function."
  }
}
variable "bootstrap_secret_name" {
  type        = string
  description = "Name of the Secrets Manager secret the bootstrap function creates with the DSN and first API token; required exactly when a function has the bootstrap role. Its IAM access is limited to this one name."
  default     = null
  validation {
    condition     = var.bootstrap_secret_name == null ? true : can(regex("^[A-Za-z0-9/_+=.@-]{1,512}$", var.bootstrap_secret_name))
    error_message = "bootstrap_secret_name must be a valid Secrets Manager secret name."
  }
  validation {
    condition     = (var.bootstrap_secret_name != null) == anytrue([for fn in values(var.functions) : contains(fn.roles, "bootstrap")]) && length([for fn in values(var.functions) : fn if contains(fn.roles, "bootstrap")]) <= 1
    error_message = "bootstrap_secret_name is required with exactly one bootstrap function and invalid without one."
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
      contains(keys(var.functions), trigger.function_id) && !contains(try(var.functions[trigger.function_id].roles, []), "bootstrap") &&
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
      can(regex("^[a-zA-Z0-9_-]{1,23}$", job)) && contains(keys(var.functions), trigger.function_id) && !contains(try(var.functions[trigger.function_id].roles, []), "bootstrap") &&
      trigger.retry_attempts >= 0 && trigger.retry_attempts <= 185 && floor(trigger.retry_attempts) == trigger.retry_attempts &&
      trigger.max_event_age_seconds >= 60 && trigger.max_event_age_seconds <= 86400 && floor(trigger.max_event_age_seconds) == trigger.max_event_age_seconds &&
      (trigger.dlq_arn == null ? true : can(regex("^arn:[^:]+:sqs:", trigger.dlq_arn))) &&
      length(split(" ", trigger.schedule)) == 5 &&
      try(split(" ", trigger.schedule)[4] == "*", false)
    ])
    error_message = "Cron jobs need a function, five fields with day-of-week set to * (Unix weekday numbering differs from EventBridge)."
  }
}

variable "image_uri" {
  type        = string
  description = "ECR image (tag or digest) for functions with package_type Image; required exactly when one exists. Push it to the repository output image_repository_url first (the first apply may be limited to the repository with -target)."
  default     = null
  validation {
    condition     = var.image_uri == null ? true : can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com(\\.cn)?/[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|@sha256:[a-f0-9]{64})$", var.image_uri))
    error_message = "image_uri must be an ECR image reference with a tag or a sha256 digest."
  }
  validation {
    condition     = (var.image_uri != null) == anytrue([for fn in values(var.functions) : fn.package_type == "Image"])
    error_message = "image_uri is required with a container-image function and invalid without one."
  }
}
variable "image_retention_count" {
  type        = number
  description = "Number of images kept in the ECR repository; older images expire."
  default     = 30
  validation {
    condition     = var.image_retention_count >= 1 && var.image_retention_count <= 1000 && floor(var.image_retention_count) == var.image_retention_count
    error_message = "image_retention_count must be an integer from 1 to 1000."
  }
}
variable "runtime" {
  type        = string
  description = "Lambda runtime compatible with the built handler."
  default     = "nodejs26.x"
  validation {
    condition     = contains(["nodejs22.x", "nodejs26.x"], var.runtime)
    error_message = "runtime must be nodejs22.x or nodejs26.x."
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
variable "alarm_topic_arn" {
  type        = string
  description = "Optional operator-owned SNS topic ARN notified when an alarm enters ALARM; no topic or subscription is created, and alarms exist either way."
  default     = null
  validation {
    condition     = var.alarm_topic_arn == null ? true : can(regex("^arn:aws(-cn|-us-gov)?:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,256}(\\.fifo)?$", var.alarm_topic_arn))
    error_message = "alarm_topic_arn must be null or an SNS topic ARN."
  }
}
variable "ingest_public_url" {
  type        = string
  description = "Operator-supplied public ingest URL (for example a custom domain in front of the ingest function URL); delivered to the API function as ERRTRAQ_PUBLIC_INGEST_URL so the key list can show DSNs. It cannot be derived from the ingest function URL output: that would make the API function's environment depend on a sibling and, for a shared function, on itself."
  default     = null
  validation {
    condition     = var.ingest_public_url == null ? true : can(regex("^https?://[^/?#@]+(/[^?#]*)?$", var.ingest_public_url))
    error_message = "ingest_public_url must be an HTTP(S) URL without credentials, query or fragment."
  }
}
variable "api_cors_origins" {
  type        = list(string)
  description = "Exact browser origins allowed to call the API function URL (CORS block on the URL; the application adds no headers). Requires the API to be exposed by a function that does not also expose ingest, whose URL already carries its own public policy."
  default     = []
  validation {
    condition     = length(var.api_cors_origins) <= 20 && alltrue([for origin in var.api_cors_origins : can(regex("^https?://[^/?#@*]+$", origin))])
    error_message = "api_cors_origins must be at most 20 exact HTTP(S) origins without a path or wildcard."
  }
  validation {
    condition     = length(var.api_cors_origins) == 0 || (anytrue([for fn in values(var.functions) : contains(fn.http, "api")]) && !anytrue([for fn in values(var.functions) : contains(fn.http, "api") && contains(fn.http, "ingest")]))
    error_message = "api_cors_origins needs the API exposed by a function that does not also expose ingest."
  }
}
variable "ui" {
  type = object({
    build_anchor = string
    price_class  = optional(string, "PriceClass_100")
  })
  description = "Host the built web UI (S3 behind CloudFront, with /api/0/* routed to the API function URL: ../static-site). build_anchor is the build-output path of the API function's artifact (<build>/<function id>/...); the UI build copy is <build>/ui next to the function directories. Requires the API to be exposed by a function whose URL authorization is NONE: the API checks the Bearer token itself, and origin access control would replace it."
  default     = null
  validation {
    condition     = var.ui == null ? true : anytrue([for fn in values(var.functions) : contains(fn.http, "api") && fn.auth_type == "NONE"])
    error_message = "ui needs the API exposed over HTTP with URL authorization NONE."
  }
  validation {
    condition     = var.ui == null ? true : length(var.ui.build_anchor) > 0 && !startswith(var.ui.build_anchor, "/")
    error_message = "ui.build_anchor must be a relative path."
  }
}
