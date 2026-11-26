data "google_project" "this" {
  project_id = var.project_id
}
locals {
  ingress = {
    "all"                               = "INGRESS_TRAFFIC_ALL"
    "internal"                          = "INGRESS_TRAFFIC_INTERNAL_ONLY"
    "internal-and-cloud-load-balancing" = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  }
  vpc_egress = {
    "private-ranges-only" = "PRIVATE_RANGES_ONLY"
    "all-traffic"         = "ALL_TRAFFIC"
  }
  vpc = var.vpc_network != null
  # Functions that mount the Cloud SQL socket: the Cloud SQL adapter's bindings say which instance.
  cloudsql = {
    for id, fn in var.functions : id => fn.environment["ERRTRAQ_POSTGRES_INSTANCE"]
    if contains(keys(fn.environment), "ERRTRAQ_POSTGRES_INSTANCE") && contains(keys(fn.environment), "ERRTRAQ_POSTGRES_SOCKET_DIR")
  }
  # The bootstrap role creates one secret, and only that name may be created or read by it.
  bootstrap_secrets = {
    for id, fn in var.functions : id => fn.environment["ERRTRAQ_BOOTSTRAP_SECRET_NAME"]
    if contains(fn.roles, "bootstrap") && contains(keys(fn.environment), "ERRTRAQ_BOOTSTRAP_SECRET_NAME")
  }
}
resource "google_service_account" "push" {
  project      = var.project_id
  account_id   = var.push_service_account_id
  display_name = "${var.name} Pub/Sub push (invoker only)"
}
resource "google_service_account" "scheduler" {
  project      = var.project_id
  account_id   = var.scheduler_service_account_id
  display_name = "${var.name} Cloud Scheduler (invoker only)"
}
# One service account per physical function, so grants are separable per role like AWS roles.
resource "google_service_account" "function" {
  for_each     = var.functions
  project      = var.project_id
  account_id   = "${var.name}-${each.key}"
  display_name = "${var.name} ${each.key} (${join(", ", each.value.roles)})"
}
resource "google_cloud_run_v2_service" "function" {
  for_each = var.functions
  project  = var.project_id
  location = var.region
  name     = "${var.name}-${each.key}"
  labels   = var.labels
  ingress  = local.ingress[each.value.ingress]
  # Public services skip the run.invoker check instead of granting it to allUsers: an organization
  # policy restricting IAM members to its own domain rejects allUsers (found in the first real run).
  invoker_iam_disabled = each.value.public
  deletion_protection  = var.deletion_protection
  # Pub/Sub and Scheduler tokens carry this audience instead of the service URL, which would be a
  # module cycle (the subscription needs the URL, the function needs the name).
  custom_audiences = [var.oidc_audience]
  template {
    service_account                  = google_service_account.function[each.key].email
    timeout                          = "${each.value.timeout_sec}s"
    max_instance_request_concurrency = each.value.concurrency
    scaling {
      min_instance_count = each.value.min_instances
      max_instance_count = each.value.max_instances
    }
    containers {
      image   = var.image
      command = each.value.command
      resources {
        limits = {
          cpu    = "${floor(each.value.cpu * 1000)}m"
          memory = "${each.value.memory_mb}Mi"
        }
      }
      ports {
        container_port = 8080
      }
      # Secret bindings carry the secret's resource name: the runtime reads the value through the
      # Secret Manager API, so the value never appears in the service configuration.
      dynamic "env" {
        for_each = merge(each.value.environment, each.value.secrets, local.grant_users_env[each.key])
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "volume_mounts" {
        for_each = contains(keys(local.cloudsql), each.key) ? [1] : []
        content {
          name       = "cloudsql"
          mount_path = each.value.environment["ERRTRAQ_POSTGRES_SOCKET_DIR"]
        }
      }
    }
    dynamic "volumes" {
      for_each = contains(keys(local.cloudsql), each.key) ? [1] : []
      content {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.cloudsql[each.key]]
        }
      }
    }
    dynamic "vpc_access" {
      for_each = local.vpc ? [1] : []
      content {
        egress = local.vpc_egress[each.value.vpc_egress]
        network_interfaces {
          network    = var.vpc_network
          subnetwork = var.vpc_subnetwork
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = !contains(keys(local.cloudsql), each.key) || can(regex("^/cloudsql$", each.value.environment["ERRTRAQ_POSTGRES_SOCKET_DIR"]))
      error_message = "Cloud Run mounts Cloud SQL instances at /cloudsql only."
    }
  }
}

# Invocation. HTTP ingest and API are public through invoker_iam_disabled on the service (the app
# authenticates DSN keys and tokens, the posture of a Lambda URL with auth NONE); every other service
# accepts only the identities that trigger it.
resource "google_cloud_run_v2_service_iam_member" "push" {
  for_each = { for id, fn in var.functions : id => fn if !fn.public && contains([for trigger in values(var.queue_triggers) : trigger.function_id], id) }
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.function[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.push.email}"
}
resource "google_cloud_run_v2_service_iam_member" "scheduler" {
  for_each = { for id, fn in var.functions : id => fn if !fn.public && contains([for trigger in values(var.cron_triggers) : trigger.function_id], id) }
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.function[each.key].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}
resource "google_cloud_run_v2_service_iam_member" "operator" {
  for_each = { for pair in setproduct([for id, fn in var.functions : id if contains(fn.roles, "bootstrap")], var.operator_members) : "${pair[0]}|${pair[1]}" => pair }
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.function[each.value[0]].name
  role     = "roles/run.invoker"
  member   = each.value[1]
}

# Pub/Sub push subscriptions, created under the names the pubsub module reserves.
locals {
  subscription_names = { for key, trigger in var.queue_triggers : key => element(split("/", trigger.subscription), 3) }
  topic_ids          = { for key, trigger in var.queue_triggers : key => "projects/${element(split("/", trigger.subscription), 1)}/topics/${local.subscription_names[key]}" }
  dlq_topic_ids      = { for key, trigger in var.queue_triggers : key => "${local.topic_ids[key]}-dlq" if trigger.dlq_enabled }
}
# The Pub/Sub service agent forwards dead letters and mints the OIDC tokens. google_project_service_identity
# is a google-beta resource (never used here), so the agent address derives from the project number; the
# agent exists once the Pub/Sub API is enabled (`gcloud beta services identity create --service=pubsub.googleapis.com`
# creates it explicitly).
locals {
  pubsub_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
resource "google_pubsub_subscription" "push" {
  for_each                   = var.queue_triggers
  project                    = var.project_id
  name                       = local.subscription_names[each.key]
  topic                      = local.topic_ids[each.key]
  labels                     = var.labels
  ack_deadline_seconds       = each.value.ack_deadline_sec
  enable_message_ordering    = each.value.ordered
  message_retention_duration = "604800s"
  expiration_policy {
    ttl = ""
  }
  push_config {
    push_endpoint = "${google_cloud_run_v2_service.function[each.value.function_id].uri}${each.value.push_path}"
    oidc_token {
      service_account_email = google_service_account.push.email
      audience              = var.oidc_audience
    }
  }
  dynamic "retry_policy" {
    for_each = each.value.min_backoff_sec != null && each.value.max_backoff_sec != null ? [1] : []
    content {
      minimum_backoff = "${each.value.min_backoff_sec}s"
      maximum_backoff = "${each.value.max_backoff_sec}s"
    }
  }
  dynamic "dead_letter_policy" {
    for_each = each.value.dlq_enabled ? [1] : []
    content {
      dead_letter_topic     = local.dlq_topic_ids[each.key]
      max_delivery_attempts = each.value.max_delivery_attempts
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.push]
}
resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  for_each = local.dlq_topic_ids
  project  = var.project_id
  topic    = each.value
  role     = "roles/pubsub.publisher"
  member   = local.pubsub_agent
}
resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  for_each     = local.dlq_topic_ids
  project      = var.project_id
  subscription = google_pubsub_subscription.push[each.key].name
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}
resource "google_service_account_iam_member" "push_token_creator" {
  count              = length(var.queue_triggers) > 0 ? 1 : 0
  service_account_id = google_service_account.push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_agent
}

# Cloud Scheduler jobs (UTC unless a schedule says otherwise), authenticated with an OIDC token.
resource "google_cloud_scheduler_job" "cron" {
  for_each         = var.cron_triggers
  project          = var.project_id
  region           = var.region
  name             = "${var.name}-${each.key}"
  description      = "errtraq ${each.key}"
  schedule         = each.value.schedule
  time_zone        = each.value.time_zone
  attempt_deadline = "${min(max(var.functions[each.value.function_id].timeout_sec, 15), 1800)}s"
  retry_config {
    retry_count = each.value.retry_count
  }
  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.function[each.value.function_id].uri}${each.value.path}"
    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = var.oidc_audience
    }
  }
  depends_on = [google_cloud_run_v2_service_iam_member.scheduler]
}

# Secret reads: accessor on exactly the declared secret, per function.
resource "google_secret_manager_secret_iam_member" "read" {
  for_each = { for pair in flatten([for id, fn in var.functions : [for secret in distinct(fn.secret_reads) : { id = id, secret = secret }]]) : "${pair.id}|${pair.secret}" => pair }
  project  = element(split("/", each.value.secret), 1)
  # A pinned version still grants on the secret, the unit IAM applies to.
  secret_id = element(split("/", each.value.secret), 3)
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.function[each.value.id].email}"
}
# The bootstrap function creates the one secret that carries the DSN and the first API token.
resource "google_project_iam_custom_role" "bootstrap_secret" {
  count       = length(local.bootstrap_secrets) > 0 ? 1 : 0
  project     = var.project_id
  role_id     = "${replace(var.name, "-", "_")}_bootstrap_secret"
  title       = "errtraq ${var.name} bootstrap secret"
  description = "Create, read and version the bootstrap secret; bound with a condition on its name."
  permissions = ["secretmanager.secrets.create", "secretmanager.secrets.get", "secretmanager.versions.add", "secretmanager.versions.access"]
  stage       = "GA"
}
resource "google_project_iam_member" "bootstrap_secret" {
  for_each = local.bootstrap_secrets
  project  = var.project_id
  role     = google_project_iam_custom_role.bootstrap_secret[0].name
  member   = "serviceAccount:${google_service_account.function[each.key].email}"
  condition {
    title       = "errtraq bootstrap secret"
    description = "Limits the grant to the ${each.value} secret."
    # Secret Manager names resources by project number in conditions.
    expression = "resource.name == \"projects/${data.google_project.this.number}/secrets/${each.value}\" || resource.name.startsWith(\"projects/${data.google_project.this.number}/secrets/${each.value}/\")"
  }
}

# Binding documents from the adapters' policy outputs: JSON lists of { role, resource, condition?,
# iam_database_user? } applied to the function's service account. The resource form selects the
# Terraform resource; an unknown form fails the plan instead of being skipped.
locals {
  bindings = flatten([
    for id, fn in var.functions : [
      for policy_index, document in fn.policies : [
        for binding_index, binding in jsondecode(document) : merge(binding, {
          function  = id
          key       = "${id}|${policy_index}|${binding_index}"
          condition = try(binding.condition, null)
          kind = (
            can(regex("^projects/[^/]+$", binding.resource)) ? "project" :
            can(regex("^projects/_/buckets/[^/]+$", binding.resource)) ? "bucket" :
            can(regex("^projects/[^/]+/topics/[^/]+$", binding.resource)) ? "topic" :
            "unsupported"
          )
        })
      ]
    ]
  ])
  project_bindings = { for b in local.bindings : b.key => b if b.kind == "project" }
  bucket_bindings  = { for b in local.bindings : b.key => b if b.kind == "bucket" }
  topic_bindings   = { for b in local.bindings : b.key => b if b.kind == "topic" }
  unsupported      = [for b in local.bindings : b.resource if b.kind == "unsupported"]
  # Cloud SQL IAM database users: one per function service account and instance.
  sql_users = {
    for pair in distinct(flatten([
      for b in local.bindings : [{ function = b.function, project = b.iam_database_user.project, instance = b.iam_database_user.instance }]
      if can(b.iam_database_user)
    ])) : "${pair.function}|${pair.project}|${pair.instance}" => pair
  }
}
# The bootstrap role grants data access to the users of every function (the migrating user owns the
# tables). Derived from the service account emails, not from google_sql_user, so the services stay
# independent of the user resources.
locals {
  sql_user_names = sort(distinct([for key, user in local.sql_users : trimsuffix(google_service_account.function[user.function].email, ".gserviceaccount.com")]))
  grant_users_env = {
    for id, fn in var.functions : id => contains(fn.roles, "bootstrap") && length(local.sql_user_names) > 0 ? { ERRTRAQ_POSTGRES_GRANT_USERS = join(",", local.sql_user_names) } : {}
  }
}
resource "terraform_data" "binding_forms" {
  lifecycle {
    precondition {
      condition     = length(local.unsupported) == 0
      error_message = "Unsupported binding resource form: ${join(", ", local.unsupported)}."
    }
  }
}
resource "google_project_iam_member" "binding" {
  for_each = local.project_bindings
  project  = element(split("/", each.value.resource), 1)
  role     = each.value.role
  member   = "serviceAccount:${google_service_account.function[each.value.function].email}"
  dynamic "condition" {
    for_each = each.value.condition == null ? [] : [each.value.condition]
    content {
      title       = condition.value.title
      description = try(condition.value.description, null)
      expression  = condition.value.expression
    }
  }
  depends_on = [terraform_data.binding_forms]
}
resource "google_storage_bucket_iam_member" "binding" {
  for_each = local.bucket_bindings
  bucket   = element(split("/", each.value.resource), 3)
  role     = each.value.role
  member   = "serviceAccount:${google_service_account.function[each.value.function].email}"
  dynamic "condition" {
    for_each = each.value.condition == null ? [] : [each.value.condition]
    content {
      title       = condition.value.title
      description = try(condition.value.description, null)
      expression  = condition.value.expression
    }
  }
  depends_on = [terraform_data.binding_forms]
}
resource "google_pubsub_topic_iam_member" "binding" {
  for_each = local.topic_bindings
  project  = element(split("/", each.value.resource), 1)
  topic    = element(split("/", each.value.resource), 3)
  role     = each.value.role
  member   = "serviceAccount:${google_service_account.function[each.value.function].email}"
  dynamic "condition" {
    for_each = each.value.condition == null ? [] : [each.value.condition]
    content {
      title       = condition.value.title
      description = try(condition.value.description, null)
      expression  = condition.value.expression
    }
  }
  depends_on = [terraform_data.binding_forms]
}
# IAM database users are named after the service account email without the .gserviceaccount.com suffix.
resource "google_sql_user" "iam" {
  for_each = local.sql_users
  project  = each.value.project
  instance = each.value.instance
  name     = trimsuffix(google_service_account.function[each.value.function].email, ".gserviceaccount.com")
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
}
