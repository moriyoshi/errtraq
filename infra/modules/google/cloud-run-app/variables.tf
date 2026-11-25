variable "name" {
  type        = string
  description = "Stack name used as the resource name prefix."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,19}$", var.name))
    error_message = "name must be 1-20 lowercase letters, digits or hyphens and start with a letter (service account ids hold <name>-<function id> within 30 characters)."
  }
}
variable "labels" {
  type        = map(string)
  description = "Labels applied to Cloud Run services and Scheduler jobs."
  default     = {}
  validation {
    condition     = alltrue([for key, value in var.labels : can(regex("^[a-z][a-z0-9_-]{0,62}$", key)) && can(regex("^[a-z0-9_-]{0,63}$", value))])
    error_message = "Label keys and values must follow GCP label rules (lowercase letters, digits, underscores, hyphens)."
  }
}
variable "project_id" {
  type        = string
  description = "Project that owns every resource. Required and never defaulted."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a GCP project id."
  }
}
variable "region" {
  type        = string
  description = "Region of the services, subscriptions' push targets and Scheduler jobs. Required and never defaulted."
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "region must be a GCP region identifier such as europe-west1."
  }
}
variable "image" {
  type        = string
  description = "Container image of every function, pinned by digest (registry/path@sha256:...)."
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]*(:[0-9]+)?/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$", var.image))
    error_message = "image must be a registry path pinned by sha256 digest."
  }
}
variable "vpc_network" {
  type        = string
  description = "Optional network for Direct VPC egress; set together with vpc_subnetwork."
  default     = null
}
variable "vpc_subnetwork" {
  type        = string
  description = "Optional subnetwork for Direct VPC egress; set together with vpc_network."
  default     = null
  validation {
    condition     = (var.vpc_network == null) == (var.vpc_subnetwork == null)
    error_message = "vpc_network and vpc_subnetwork must be set together."
  }
}
variable "oidc_audience" {
  type        = string
  description = "Audience of the OIDC tokens Pub/Sub and Cloud Scheduler attach. Not a URL: every service lists it as a custom audience so Cloud Run accepts it."
  validation {
    condition     = length(var.oidc_audience) >= 1 && length(var.oidc_audience) <= 256
    error_message = "oidc_audience must be 1-256 characters."
  }
}
variable "push_service_account_id" {
  type        = string
  description = "Account id (not the email) of the service account Pub/Sub pushes as; invoker only on the services its subscriptions feed."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.push_service_account_id))
    error_message = "push_service_account_id must be a 6-30 character service account id."
  }
}
variable "scheduler_service_account_id" {
  type        = string
  description = "Account id (not the email) of the service account Cloud Scheduler calls as; invoker only on the services its jobs call."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.scheduler_service_account_id)) && var.scheduler_service_account_id != var.push_service_account_id
    error_message = "scheduler_service_account_id must be a 6-30 character service account id different from the push one."
  }
}
variable "operator_members" {
  type        = list(string)
  description = "IAM members (for example user:...) allowed to invoke the authenticated bootstrap service; empty leaves it invocable by no one."
  default     = []
}
variable "deletion_protection" {
  type        = bool
  description = "Cloud Run deletion protection. Services are stateless, so the default allows teardown."
  default     = false
}
variable "functions" {
  description = "Physical functions with their scoped bindings. policies are JSON binding documents ({ role, resource, condition? } lists); secret_reads are Secret Manager secret resource names."
  type = map(object({
    roles         = list(string)
    http          = list(string)
    public        = bool
    command       = list(string)
    memory_mb     = number
    cpu           = number
    timeout_sec   = number
    concurrency   = number
    min_instances = number
    max_instances = number
    ingress       = string
    vpc_egress    = string
    environment   = map(string)
    secrets       = map(string)
    policies      = list(string)
    secret_reads  = list(string)
  }))
  validation {
    condition = alltrue([for id, fn in var.functions :
      can(regex("^[a-z][a-z0-9]{0,8}$", id)) &&
      length(fn.roles) > 0 && alltrue([for role in fn.roles : contains(["ingest", "api", "consumer", "record", "cron", "archive", "bootstrap"], role)]) &&
      alltrue([for role in fn.http : contains(["ingest", "api"], role) && contains(fn.roles, role)]) &&
      length(fn.command) > 0 &&
      fn.memory_mb >= 128 && fn.memory_mb <= 32768 && floor(fn.memory_mb) == fn.memory_mb &&
      fn.cpu >= 0.08 && fn.cpu <= 8 &&
      fn.timeout_sec >= 1 && fn.timeout_sec <= 3600 && floor(fn.timeout_sec) == fn.timeout_sec &&
      fn.concurrency >= 1 && fn.concurrency <= 1000 && floor(fn.concurrency) == fn.concurrency &&
      fn.min_instances >= 0 && fn.max_instances >= 1 && fn.min_instances <= fn.max_instances &&
      contains(["all", "internal", "internal-and-cloud-load-balancing"], fn.ingress) &&
      contains(["private-ranges-only", "all-traffic"], fn.vpc_egress) &&
      # Only functions that serve ingest or API are reachable without credentials.
      fn.public == (length(fn.http) > 0) &&
      length(setintersection(toset(keys(fn.environment)), toset(keys(fn.secrets)))) == 0 &&
      alltrue([for secret in fn.secret_reads : can(regex("^projects/[^/]+/secrets/[^/]+(/versions/[^/]+)?$", secret))]) &&
      alltrue([for secret in values(fn.secrets) : contains(fn.secret_reads, secret)]) &&
      # The bootstrap role is operator-invoked only: its own function, never exposed or triggered.
      (!contains(fn.roles, "bootstrap") || (length(fn.roles) == 1 && length(fn.http) == 0))
    ])
    error_message = "Functions need a short lowercase id (service account ids hold <name>-<id> within 30 characters), valid roles, limits, ingress, distinct bindings and Secret Manager resource names for their secret reads; bootstrap stands alone."
  }
  validation {
    condition     = alltrue([for role in ["ingest", "api"] : length([for fn in values(var.functions) : fn if contains(fn.http, role)]) <= 1])
    error_message = "Each HTTP role may be exposed by at most one function."
  }
  validation {
    condition     = alltrue([for id, fn in var.functions : length("${var.name}-${id}") <= 30])
    error_message = "<name>-<function id> must fit a service account id (30 characters)."
  }
  validation {
    condition     = length([for fn in values(var.functions) : fn if contains(fn.roles, "bootstrap")]) <= 1
    error_message = "At most one function may have the bootstrap role."
  }
}
variable "queue_triggers" {
  description = "Push subscriptions keyed by physical queue. subscription is the full reserved name projects/<project>/subscriptions/<name>-<physical>; the topic is projects/<project>/topics/<same name> and the dead-letter topic projects/<project>/topics/<same name>-dlq (the pubsub module's naming contract)."
  type = map(object({
    function_id           = string
    subscription          = string
    topics                = list(string)
    push_path             = string
    ack_deadline_sec      = number
    ordered               = optional(bool, false)
    min_backoff_sec       = optional(number)
    max_backoff_sec       = optional(number)
    dlq_enabled           = optional(bool, false)
    max_delivery_attempts = optional(number)
  }))
  default = {}
  validation {
    condition = alltrue([for trigger in values(var.queue_triggers) :
      contains(keys(var.functions), trigger.function_id) && !contains(try(var.functions[trigger.function_id].roles, []), "bootstrap") &&
      can(regex("^projects/[^/]+/subscriptions/[a-z][a-z0-9-]{2,254}$", trigger.subscription)) &&
      startswith(trigger.push_path, "/_errtraq/push/") &&
      trigger.ack_deadline_sec >= 10 && trigger.ack_deadline_sec <= 600 && floor(trigger.ack_deadline_sec) == trigger.ack_deadline_sec &&
      (trigger.min_backoff_sec == null ? true : trigger.min_backoff_sec >= 0 && trigger.min_backoff_sec <= 600) &&
      (trigger.max_backoff_sec == null ? true : trigger.max_backoff_sec >= 0 && trigger.max_backoff_sec <= 600) &&
      (trigger.min_backoff_sec == null || trigger.max_backoff_sec == null ? true : trigger.min_backoff_sec <= trigger.max_backoff_sec) &&
      (!trigger.dlq_enabled || (trigger.max_delivery_attempts != null && try(trigger.max_delivery_attempts >= 5 && trigger.max_delivery_attempts <= 100 && floor(trigger.max_delivery_attempts) == trigger.max_delivery_attempts, false)))
    ])
    error_message = "Queue triggers need a non-bootstrap function, a reserved subscription name, an internal push path, an ack deadline of 10-600 seconds, ordered backoffs and 5-100 delivery attempts with a dead-letter queue."
  }
}
variable "cron_triggers" {
  description = "Cloud Scheduler jobs keyed by job name; schedules are five-field cron expressions in the given time zone."
  type = map(object({
    function_id = string
    schedule    = string
    time_zone   = optional(string, "UTC")
    path        = string
    retry_count = optional(number, 3)
  }))
  default = {}
  validation {
    condition = alltrue([for job, trigger in var.cron_triggers :
      can(regex("^[a-zA-Z0-9_-]{1,40}$", job)) && contains(keys(var.functions), trigger.function_id) && !contains(try(var.functions[trigger.function_id].roles, []), "bootstrap") &&
      length(split(" ", trigger.schedule)) == 5 && startswith(trigger.path, "/_errtraq/cron/") &&
      trigger.retry_count >= 0 && trigger.retry_count <= 5 && floor(trigger.retry_count) == trigger.retry_count
    ])
    error_message = "Cron jobs need a non-bootstrap function, a five-field schedule, an internal cron path and 0-5 retries."
  }
}
