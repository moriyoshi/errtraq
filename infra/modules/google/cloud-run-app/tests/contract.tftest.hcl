mock_provider "google" {
  mock_data "google_project" { defaults = { number = "123456789012" } }
  mock_resource "google_service_account" {
    defaults = {
      email = "mock-account@example-project.iam.gserviceaccount.com"
      name  = "projects/example-project/serviceAccounts/mock-account@example-project.iam.gserviceaccount.com"
    }
  }
  mock_resource "google_cloud_run_v2_service" { defaults = { uri = "https://mock-service-abc123-ew.a.run.app" } }
}
variables {
  name                         = "example"
  project_id                   = "example-project"
  region                       = "europe-west1"
  image                        = "europe-west1-docker.pkg.dev/example-project/errtraq/app@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  oidc_audience                = "errtraq-push"
  push_service_account_id      = "errtraq-push"
  scheduler_service_account_id = "errtraq-scheduler"
  operator_members             = ["user:operator@example.test"]
  labels                       = { app = "errtraq" }
  functions = {
    ingest = {
      roles         = ["ingest"]
      http          = ["ingest"]
      public        = true
      command       = ["node", "/app/ingest/index.mjs"]
      memory_mb     = 512
      cpu           = 1
      timeout_sec   = 30
      concurrency   = 80
      min_instances = 0
      max_instances = 20
      ingress       = "all"
      vpc_egress    = "private-ranges-only"
      environment   = { ERRTRAQ_BLOB_BUCKET = "bucket" }
      secrets       = {}
      policies = [
        jsonencode([{ role = "projects/example-project/roles/example_blob_write", resource = "projects/_/buckets/bucket" }]),
        jsonencode([{ role = "roles/pubsub.publisher", resource = "projects/example-project/topics/example-shared" }]),
      ]
      secret_reads = []
    }
    api = {
      roles         = ["api"]
      http          = ["api"]
      public        = true
      command       = ["node", "/app/api/index.mjs"]
      memory_mb     = 512
      cpu           = 1
      timeout_sec   = 30
      concurrency   = 80
      min_instances = 0
      max_instances = 20
      ingress       = "all"
      vpc_egress    = "all-traffic"
      environment   = { ERRTRAQ_POSTGRES_INSTANCE = "example-project:europe-west1:example-sql", ERRTRAQ_POSTGRES_SOCKET_DIR = "/cloudsql" }
      secrets       = { ERRTRAQ_SOME_SECRET = "projects/example-project/secrets/api-token" }
      policies = [jsonencode([
        { role = "roles/cloudsql.instanceUser", resource = "projects/example-project", condition = { title = "t", description = "d", expression = "resource.name == 'projects/example-project/instances/example-sql'" }, iam_database_user = { project = "example-project", instance = "example-sql" } },
        { role = "roles/cloudsql.client", resource = "projects/example-project", condition = { title = "t", description = "d", expression = "resource.name == 'projects/example-project/instances/example-sql'" } },
      ])]
      secret_reads = ["projects/example-project/secrets/api-token"]
    }
    consumer = {
      roles         = ["consumer"]
      http          = []
      public        = false
      command       = ["node", "/app/consumer/index.mjs"]
      memory_mb     = 1024
      cpu           = 2
      timeout_sec   = 30
      concurrency   = 8
      min_instances = 1
      max_instances = 5
      ingress       = "internal"
      vpc_egress    = "private-ranges-only"
      environment   = {}
      secrets       = {}
      policies      = [jsonencode([]), jsonencode([{ role = "projects/example-project/roles/example_fs_store_read", resource = "projects/example-project", condition = { title = "t", expression = "resource.name == \"projects/example-project/databases/example-store\"" } }])]
      secret_reads  = []
    }
    cron = {
      roles         = ["cron"]
      http          = []
      public        = false
      command       = ["node", "/app/cron/index.mjs"]
      memory_mb     = 512
      cpu           = 1
      timeout_sec   = 30
      concurrency   = 1
      min_instances = 0
      max_instances = 20
      ingress       = "all"
      vpc_egress    = "private-ranges-only"
      environment   = {}
      secrets       = {}
      policies      = []
      secret_reads  = []
    }
    bootstrap = {
      roles         = ["bootstrap"]
      http          = []
      public        = false
      command       = ["node", "/app/bootstrap/index.mjs"]
      memory_mb     = 512
      cpu           = 1
      timeout_sec   = 120
      concurrency   = 1
      min_instances = 0
      max_instances = 1
      ingress       = "all"
      vpc_egress    = "private-ranges-only"
      environment   = { ERRTRAQ_BOOTSTRAP_SECRET_NAME = "errtraq-bootstrap" }
      secrets       = {}
      policies      = []
      secret_reads  = []
    }
  }
  queue_triggers = {
    shared = {
      function_id           = "consumer"
      subscription          = "projects/example-project/subscriptions/example-shared"
      topics                = ["ingest"]
      push_path             = "/_errtraq/push/shared"
      ack_deadline_sec      = 180
      ordered               = false
      min_backoff_sec       = 10
      max_backoff_sec       = 600
      dlq_enabled           = true
      max_delivery_attempts = 5
    }
    record = {
      function_id      = "consumer"
      subscription     = "projects/example-project/subscriptions/example-record"
      topics           = ["record"]
      push_path        = "/_errtraq/push/record"
      ack_deadline_sec = 120
      ordered          = true
    }
  }
  cron_triggers = {
    "bundle-cleanup" = { function_id = "cron", schedule = "*/15 * * * *", time_zone = "UTC", path = "/_errtraq/cron/bundle-cleanup", retry_count = 3 }
  }
}
run "functions_triggers_and_urls" {
  command = apply
  assert {
    condition     = output.ingest_url == "https://mock-service-abc123-ew.a.run.app" && output.api_url == output.ingest_url && output.bootstrap_url == output.ingest_url && toset(keys(output.service_account_emails)) == toset(["ingest", "api", "consumer", "cron", "bootstrap"])
    error_message = "URLs and per-function service accounts must be exposed."
  }
  assert {
    condition     = toset([for id, account in google_service_account.function : account.account_id]) == toset(["example-ingest", "example-api", "example-consumer", "example-cron", "example-bootstrap"]) && google_service_account.push.account_id == "errtraq-push" && google_service_account.scheduler.account_id == "errtraq-scheduler"
    error_message = "One service account per function plus the two invoker accounts, created from their ids."
  }
  assert {
    condition = alltrue([for id, service in google_cloud_run_v2_service.function :
      toset(service.custom_audiences) == toset(["errtraq-push"]) && service.template[0].containers[0].image == var.image && service.project == "example-project" && service.location == "europe-west1" && service.deletion_protection == false
    ])
    error_message = "Every service accepts the OIDC audience, runs the pinned image and lives in the explicit project and region."
  }
  assert {
    condition = alltrue([
      google_cloud_run_v2_service.function["consumer"].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY",
      google_cloud_run_v2_service.function["ingest"].ingress == "INGRESS_TRAFFIC_ALL",
      google_cloud_run_v2_service.function["consumer"].template[0].max_instance_request_concurrency == 8,
      google_cloud_run_v2_service.function["consumer"].template[0].scaling[0].min_instance_count == 1,
      google_cloud_run_v2_service.function["consumer"].template[0].scaling[0].max_instance_count == 5,
      google_cloud_run_v2_service.function["consumer"].template[0].containers[0].resources[0].limits["cpu"] == "2000m",
      google_cloud_run_v2_service.function["consumer"].template[0].containers[0].resources[0].limits["memory"] == "1024Mi",
      google_cloud_run_v2_service.function["bootstrap"].template[0].timeout == "120s",
      join(" ", google_cloud_run_v2_service.function["ingest"].template[0].containers[0].command) == "node /app/ingest/index.mjs",
    ])
    error_message = "Ingress, concurrency, scaling, resources, timeout and command come from the function settings."
  }
  assert {
    condition     = alltrue([for id, service in google_cloud_run_v2_service.function : service.template[0].service_account == google_service_account.function[id].email])
    error_message = "Each service runs as its own service account, never the default compute account."
  }
  assert {
    condition = alltrue([
      length(google_cloud_run_v2_service.function["ingest"].template[0].vpc_access) == 0,
      length(google_cloud_run_v2_service.function["api"].template[0].volumes) == 1,
      toset(one(google_cloud_run_v2_service.function["api"].template[0].volumes).cloud_sql_instance[0].instances) == toset(["example-project:europe-west1:example-sql"]),
      one(google_cloud_run_v2_service.function["api"].template[0].containers[0].volume_mounts).mount_path == "/cloudsql",
      length(google_cloud_run_v2_service.function["ingest"].template[0].volumes) == 0,
    ])
    error_message = "Only a function bound to a Cloud SQL instance mounts the socket volume."
  }
  assert {
    condition = alltrue([
      toset([for env in google_cloud_run_v2_service.function["api"].template[0].containers[0].env : env.name]) == toset(["ERRTRAQ_POSTGRES_INSTANCE", "ERRTRAQ_POSTGRES_SOCKET_DIR", "ERRTRAQ_SOME_SECRET"]),
      one([for env in google_cloud_run_v2_service.function["api"].template[0].containers[0].env : env.value if env.name == "ERRTRAQ_SOME_SECRET"]) == "projects/example-project/secrets/api-token",
    ])
    error_message = "Secret bindings deliver the secret resource name, never a value, alongside the environment."
  }
  assert {
    condition = alltrue([
      toset(keys(google_cloud_run_v2_service_iam_member.public)) == toset(["ingest", "api"]),
      alltrue([for member in values(google_cloud_run_v2_service_iam_member.public) : member.member == "allUsers" && member.role == "roles/run.invoker"]),
      toset(keys(google_cloud_run_v2_service_iam_member.push)) == toset(["consumer"]),
      toset(keys(google_cloud_run_v2_service_iam_member.scheduler)) == toset(["cron"]),
      toset(keys(google_cloud_run_v2_service_iam_member.operator)) == toset(["bootstrap|user:operator@example.test"]),
      google_cloud_run_v2_service_iam_member.operator["bootstrap|user:operator@example.test"].member == "user:operator@example.test",
      google_cloud_run_v2_service_iam_member.push["consumer"].member == "serviceAccount:${google_service_account.push.email}",
      google_cloud_run_v2_service_iam_member.scheduler["cron"].member == "serviceAccount:${google_service_account.scheduler.email}",
    ])
    error_message = "allUsers invokes only the HTTP ingest and API services; internal services admit only the push, scheduler and operator identities that trigger them."
  }
  assert {
    condition = alltrue([
      toset(keys(google_pubsub_subscription.push)) == toset(["shared", "record"]),
      google_pubsub_subscription.push["shared"].name == "example-shared",
      google_pubsub_subscription.push["shared"].topic == "projects/example-project/topics/example-shared",
      google_pubsub_subscription.push["shared"].ack_deadline_seconds == 180,
      !google_pubsub_subscription.push["shared"].enable_message_ordering,
      google_pubsub_subscription.push["record"].enable_message_ordering,
      google_pubsub_subscription.push["shared"].push_config[0].push_endpoint == "https://mock-service-abc123-ew.a.run.app/_errtraq/push/shared",
      google_pubsub_subscription.push["shared"].push_config[0].oidc_token[0].audience == "errtraq-push",
      google_pubsub_subscription.push["shared"].push_config[0].oidc_token[0].service_account_email == google_service_account.push.email,
      google_pubsub_subscription.push["shared"].retry_policy[0].minimum_backoff == "10s",
      google_pubsub_subscription.push["shared"].retry_policy[0].maximum_backoff == "600s",
      google_pubsub_subscription.push["shared"].dead_letter_policy[0].dead_letter_topic == "projects/example-project/topics/example-shared-dlq",
      google_pubsub_subscription.push["shared"].dead_letter_policy[0].max_delivery_attempts == 5,
      length(google_pubsub_subscription.push["record"].dead_letter_policy) == 0,
      length(google_pubsub_subscription.push["record"].retry_policy) == 0,
      google_pubsub_subscription.push["shared"].expiration_policy[0].ttl == "",
    ])
    error_message = "Push subscriptions use the reserved names with OIDC, ack deadline, ordering, retry and dead-letter settings."
  }
  assert {
    condition = alltrue([
      toset(keys(google_pubsub_topic_iam_member.dead_letter_publisher)) == toset(["shared"]),
      google_pubsub_topic_iam_member.dead_letter_publisher["shared"].topic == "projects/example-project/topics/example-shared-dlq",
      google_pubsub_topic_iam_member.dead_letter_publisher["shared"].role == "roles/pubsub.publisher",
      google_pubsub_topic_iam_member.dead_letter_publisher["shared"].member == "serviceAccount:service-123456789012@gcp-sa-pubsub.iam.gserviceaccount.com",
      toset(keys(google_pubsub_subscription_iam_member.dead_letter_subscriber)) == toset(["shared"]),
      google_pubsub_subscription_iam_member.dead_letter_subscriber["shared"].role == "roles/pubsub.subscriber",
      google_pubsub_subscription_iam_member.dead_letter_subscriber["shared"].member == "serviceAccount:service-123456789012@gcp-sa-pubsub.iam.gserviceaccount.com",
      google_service_account_iam_member.push_token_creator[0].role == "roles/iam.serviceAccountTokenCreator",
    ])
    error_message = "The Pub/Sub service agent can publish dead letters, subscribe to the source and mint push tokens, and only for dead-lettering queues."
  }
  assert {
    condition = alltrue([
      toset(keys(google_cloud_scheduler_job.cron)) == toset(["bundle-cleanup"]),
      google_cloud_scheduler_job.cron["bundle-cleanup"].name == "example-bundle-cleanup",
      google_cloud_scheduler_job.cron["bundle-cleanup"].time_zone == "UTC",
      google_cloud_scheduler_job.cron["bundle-cleanup"].schedule == "*/15 * * * *",
      google_cloud_scheduler_job.cron["bundle-cleanup"].retry_config[0].retry_count == 3,
      google_cloud_scheduler_job.cron["bundle-cleanup"].http_target[0].uri == "https://mock-service-abc123-ew.a.run.app/_errtraq/cron/bundle-cleanup",
      google_cloud_scheduler_job.cron["bundle-cleanup"].http_target[0].oidc_token[0].audience == "errtraq-push",
      google_cloud_scheduler_job.cron["bundle-cleanup"].http_target[0].oidc_token[0].service_account_email == google_service_account.scheduler.email,
    ])
    error_message = "Scheduler jobs call the cron route in UTC with the scheduler identity's OIDC token."
  }
  assert {
    condition = alltrue([
      toset(keys(google_secret_manager_secret_iam_member.read)) == toset(["api|projects/example-project/secrets/api-token"]),
      one(values(google_secret_manager_secret_iam_member.read)).secret_id == "api-token",
      one(values(google_secret_manager_secret_iam_member.read)).role == "roles/secretmanager.secretAccessor",
    ])
    error_message = "Secret accessor is bound per function on exactly the declared secret."
  }
  assert {
    condition = alltrue([
      toset(keys(google_project_iam_member.bootstrap_secret)) == toset(["bootstrap"]),
      toset(google_project_iam_custom_role.bootstrap_secret[0].permissions) == toset(["secretmanager.secrets.create", "secretmanager.secrets.get", "secretmanager.versions.add", "secretmanager.versions.access"]),
      strcontains(google_project_iam_member.bootstrap_secret["bootstrap"].condition[0].expression, "projects/123456789012/secrets/errtraq-bootstrap"),
    ])
    error_message = "The bootstrap function may create and use only its named secret."
  }
  assert {
    condition = alltrue([
      toset(keys(google_storage_bucket_iam_member.binding)) == toset(["ingest|0|0"]),
      google_storage_bucket_iam_member.binding["ingest|0|0"].bucket == "bucket",
      google_storage_bucket_iam_member.binding["ingest|0|0"].role == "projects/example-project/roles/example_blob_write",
      toset(keys(google_pubsub_topic_iam_member.binding)) == toset(["ingest|1|0"]),
      google_pubsub_topic_iam_member.binding["ingest|1|0"].topic == "example-shared",
      google_pubsub_topic_iam_member.binding["ingest|1|0"].role == "roles/pubsub.publisher",
      toset(keys(google_project_iam_member.binding)) == toset(["api|0|0", "api|0|1", "consumer|1|0"]),
      google_project_iam_member.binding["api|0|0"].role == "roles/cloudsql.instanceUser",
      google_project_iam_member.binding["api|0|0"].condition[0].expression == "resource.name == 'projects/example-project/instances/example-sql'",
      google_project_iam_member.binding["consumer|1|0"].role == "projects/example-project/roles/example_fs_store_read",
      alltrue([for key, member in google_project_iam_member.binding : member.member == "serviceAccount:${google_service_account.function[split("|", key)[0]].email}"]),
    ])
    error_message = "Each binding document entry binds its role to the owning function's service account on the resource it names, with its condition."
  }
  assert {
    condition = alltrue([
      toset(keys(google_sql_user.iam)) == toset(["api|example-project|example-sql"]),
      one(values(google_sql_user.iam)).type == "CLOUD_IAM_SERVICE_ACCOUNT",
      one(values(google_sql_user.iam)).name == "mock-account@example-project.iam",
      one(values(google_sql_user.iam)).instance == "example-sql",
    ])
    error_message = "One IAM database user per function service account that holds the Cloud SQL login."
  }
}
run "vpc_egress_and_extras" {
  command = apply
  variables {
    vpc_network    = "projects/example-project/global/networks/main"
    vpc_subnetwork = "projects/example-project/regions/europe-west1/subnetworks/main"
  }
  assert {
    condition = alltrue([for id, service in google_cloud_run_v2_service.function :
      service.template[0].vpc_access[0].network_interfaces[0].network == "projects/example-project/global/networks/main" && service.template[0].vpc_access[0].egress == (id == "api" ? "ALL_TRAFFIC" : "PRIVATE_RANGES_ONLY")
    ])
    error_message = "Direct VPC egress follows each function's egress setting."
  }
}
run "reject_unsupported_binding_form" {
  command = plan
  variables {
    functions = {
      ingest = {
        roles         = ["ingest"]
        http          = ["ingest"]
        public        = true
        command       = ["node", "x"]
        memory_mb     = 512
        cpu           = 1
        timeout_sec   = 30
        concurrency   = 80
        min_instances = 0
        max_instances = 20
        ingress       = "all"
        vpc_egress    = "private-ranges-only"
        environment   = {}
        secrets       = {}
        policies      = [jsonencode([{ role = "roles/viewer", resource = "folders/123" }])]
        secret_reads  = []
      }
    }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [terraform_data.binding_forms]
}
run "reject_public_internal_function" {
  command = plan
  variables {
    functions = {
      consumer = {
        roles         = ["consumer"]
        http          = []
        public        = true
        command       = ["node", "x"]
        memory_mb     = 512
        cpu           = 1
        timeout_sec   = 30
        concurrency   = 8
        min_instances = 0
        max_instances = 20
        ingress       = "all"
        vpc_egress    = "private-ranges-only"
        environment   = {}
        secrets       = {}
        policies      = []
        secret_reads  = []
      }
    }
    queue_triggers = {}
    cron_triggers  = {}
  }
  expect_failures = [var.functions]
}
run "reject_tag_image" {
  command = plan
  variables {
    image = "europe-west1-docker.pkg.dev/example-project/errtraq/app:latest"
  }
  expect_failures = [var.image]
}
run "reject_bootstrap_trigger" {
  command = plan
  variables {
    queue_triggers = {
      shared = {
        function_id      = "bootstrap"
        subscription     = "projects/example-project/subscriptions/example-shared"
        topics           = ["ingest"]
        push_path        = "/_errtraq/push/shared"
        ack_deadline_sec = 180
      }
    }
  }
  expect_failures = [var.queue_triggers]
}
