mock_provider "google" {}
run "cloudsql_policies" {
  command = apply
  variables {
    instance_connection_name = "example-project:europe-west1:example-sql"
    region                   = "europe-west1"
  }
  assert {
    condition = alltrue([for capability in ["read", "write", "delete"] : jsonencode(jsondecode(output.policies[capability].primary)) == jsonencode([
      {
        role              = "roles/cloudsql.instanceUser"
        resource          = "projects/example-project"
        condition         = { title = "errtraq Cloud SQL instance", description = "Limits the grant to the example-sql instance.", expression = "resource.name == 'projects/example-project/instances/example-sql' && resource.type == 'sqladmin.googleapis.com/Instance'" }
        iam_database_user = { project = "example-project", instance = "example-sql" }
      },
      {
        role      = "roles/cloudsql.client"
        resource  = "projects/example-project"
        condition = { title = "errtraq Cloud SQL instance", description = "Limits the grant to the example-sql instance.", expression = "resource.name == 'projects/example-project/instances/example-sql' && resource.type == 'sqladmin.googleapis.com/Instance'" }
      },
    ])])
    error_message = "Each capability grants the login and the proxy client role, conditioned on exactly this instance, and asks for one IAM database user per function."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["read", "write", "delete"]) && alltrue([for policies in values(output.policies) : toset(keys(policies)) == toset(["primary"])])
    error_message = "Policy output shape must follow the descriptor."
  }
}
run "tcp_has_no_client_role" {
  command = apply
  variables {
    instance_connection_name = "example-project:europe-west1:example-sql"
    region                   = "europe-west1"
    transport                = "tcp"
  }
  assert {
    condition     = [for binding in jsondecode(output.policies.read.primary) : binding.role] == ["roles/cloudsql.instanceUser"]
    error_message = "A direct connection needs only the login role."
  }
}
run "operator_managed_user" {
  command = apply
  variables {
    instance_connection_name = "example-project:europe-west1:example-sql"
    region                   = "europe-west1"
    database_user            = "app_user"
  }
  assert {
    condition     = !anytrue([for binding in jsondecode(output.policies.read.primary) : can(binding.iam_database_user)])
    error_message = "A configured shared user is managed by the operator, so no per-function users are requested."
  }
}
run "domain_scoped_project" {
  command = apply
  variables {
    instance_connection_name = "example.com:example-project:europe-west1:example-sql"
    region                   = "europe-west1"
  }
  assert {
    condition     = jsondecode(output.policies.read.primary)[0].resource == "projects/example.com:example-project"
    error_message = "A domain-scoped project keeps its full id."
  }
}
run "reject_region_mismatch" {
  command = plan
  variables {
    instance_connection_name = "example-project:europe-west1:example-sql"
    region                   = "us-central1"
  }
  expect_failures = [var.region]
}
run "reject_malformed_connection_name" {
  command = plan
  variables {
    instance_connection_name = "example-sql"
    region                   = "europe-west1"
  }
  expect_failures = [var.instance_connection_name]
}
