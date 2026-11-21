mock_provider "aws" {
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
  mock_data "aws_partition" { defaults = { partition = "aws" } }
}
run "rds_connect_policies" {
  command = apply
  variables {
    resource_id   = "db-ABCDEFGHI"
    database_user = "app_user"
    region        = "us-east-1"
  }
  assert {
    condition     = alltrue([for capability in ["read", "write", "delete"] : jsonencode(jsondecode(output.policies[capability].primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["rds-db:connect"], Resource = ["arn:aws:rds-db:us-east-1:123456789012:dbuser:db-ABCDEFGHI/app_user"] }] })])
    error_message = "Each capability must grant only rds-db:connect to the exact database resource and user."
  }
}
run "proxy" {
  command = apply
  variables {
    resource_id   = "prx-ABCD"
    database_user = "worker"
    region        = "us-west-2"
  }
  assert {
    condition     = jsondecode(output.policies.read.primary).Statement[0].Resource[0] == "arn:aws:rds-db:us-west-2:123456789012:dbuser:prx-ABCD/worker"
    error_message = "Proxy access must use the proxy resource ID."
  }
}
run "cluster" {
  command = apply
  variables {
    resource_id   = "cluster-ABCD"
    database_user = "app"
    region        = "us-east-1"
  }
  assert {
    condition     = jsondecode(output.policies.read.primary).Statement[0].Resource[0] == "arn:aws:rds-db:us-east-1:123456789012:dbuser:cluster-ABCD/app"
    error_message = "Aurora access must use the cluster resource ID."
  }
}
run "reject_wildcard_user" {
  command = plan
  variables {
    resource_id   = "db-ABCD"
    database_user = "*"
    region        = "us-east-1"
  }
  expect_failures = [var.database_user]
}
run "reject_wildcard_resource" {
  command = plan
  variables {
    resource_id   = "db-*"
    database_user = "app"
    region        = "us-east-1"
  }
  expect_failures = [var.resource_id]
}
