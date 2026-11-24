mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
  mock_data "aws_region" {
    defaults = { region = "us-east-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      address     = "fx.example.invalid"
      port        = 5432
      resource_id = "db-ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      identifier  = "fx"
      master_user_secret = [{
        kms_key_id    = "alias/aws/secretsmanager"
        secret_arn    = "arn:aws:secretsmanager:us-east-1:000000000000:secret:rds-db-test"
        secret_status = "active"
      }]
    }
  }
  mock_resource "aws_db_proxy" {
    defaults = {
      arn      = "arn:aws:rds:us-east-1:000000000000:db-proxy:prx-0123456789abcdef0"
      endpoint = "fx-proxy.example.invalid"
      name     = "fx"
    }
  }
  mock_resource "aws_db_proxy_default_target_group" {
    defaults = { name = "default" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/test" }
  }
}

run "created_network" {
  command = apply
  variables {
    name_prefix = "fx-test"
  }
  assert {
    condition     = length(aws_vpc.this) == 1 && length(aws_subnet.private) == 2
    error_message = "created mode creates a VPC and two subnets"
  }
  assert {
    condition     = aws_subnet.private[0].availability_zone != aws_subnet.private[1].availability_zone
    error_message = "subnets are in two AZs"
  }
  assert {
    condition     = toset(keys(aws_vpc_endpoint.gateway)) == toset(["dynamodb", "s3"]) && toset(keys(aws_vpc_endpoint.interface)) == toset(["secretsmanager", "sqs"])
    error_message = "gateway endpoints for S3 and DynamoDB, interface endpoints for SQS and Secrets Manager"
  }
  assert {
    condition     = alltrue([for e in aws_vpc_endpoint.interface : e.private_dns_enabled])
    error_message = "interface endpoints use private DNS"
  }
  assert {
    condition     = length(aws_security_group.lambda) == 1 && length(aws_security_group.endpoints) == 1
    error_message = "created mode creates the Lambda and endpoint security groups"
  }
  assert {
    condition     = output.proxy_resource_id == "prx-0123456789abcdef0" && output.db_resource_id == "db-ABCDEFGHIJKLMNOPQRSTUVWXYZ" && output.proxy_host != null
    error_message = "resource IDs and proxy host are exposed"
  }
  assert {
    condition     = output.database_name == "errtraq" && output.port == 5432 && output.master_secret_arn != null
    error_message = "database outputs"
  }
}

run "database_hardening" {
  command = apply
  assert {
    condition = (
      aws_db_instance.this.iam_database_authentication_enabled &&
      aws_db_instance.this.storage_encrypted &&
      !aws_db_instance.this.publicly_accessible &&
      !aws_db_instance.this.multi_az &&
      !aws_db_instance.this.deletion_protection &&
      aws_db_instance.this.skip_final_snapshot &&
      aws_db_instance.this.manage_master_user_password &&
      aws_db_instance.this.backup_retention_period == 0 &&
      aws_db_instance.this.instance_class == "db.t4g.micro"
    )
    error_message = "instance settings"
  }
  assert {
    condition     = [for p in aws_db_parameter_group.this.parameter : p.value if p.name == "rds.force_ssl"] == ["1"]
    error_message = "rds.force_ssl is on"
  }
  assert {
    condition     = aws_db_proxy.this[0].require_tls && aws_db_proxy.this[0].engine_family == "POSTGRESQL" && one(aws_db_proxy.this[0].auth).iam_auth == "REQUIRED" && aws_db_proxy.this[0].default_auth_scheme == "IAM_AUTH"
    error_message = "proxy requires TLS and IAM auth"
  }
  assert {
    condition     = aws_db_proxy_target.this[0].db_instance_identifier == aws_db_instance.this.identifier
    error_message = "proxy targets the instance"
  }
  assert {
    condition     = aws_db_proxy_default_target_group.this[0].db_proxy_name == aws_db_proxy.this[0].name
    error_message = "default target group belongs to the proxy"
  }
  assert {
    condition     = aws_db_instance.this.tags["errtraq:fixture"] == "rds-postgres"
    error_message = "fixture tag"
  }
}

run "ingress_only_from_lambda_sg" {
  command = apply
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.proxy_from_lambda[0].referenced_security_group_id == aws_security_group.lambda[0].id &&
      aws_vpc_security_group_ingress_rule.database_from_lambda.referenced_security_group_id == aws_security_group.lambda[0].id &&
      aws_vpc_security_group_ingress_rule.database_from_proxy[0].referenced_security_group_id == aws_security_group.proxy[0].id
    )
    error_message = "database and proxy ingress reference security groups"
  }
  assert {
    condition = alltrue([
      for r in [
        aws_vpc_security_group_ingress_rule.proxy_from_lambda[0],
        aws_vpc_security_group_ingress_rule.database_from_lambda,
        aws_vpc_security_group_ingress_rule.database_from_proxy[0],
      ] : r.cidr_ipv4 == null && r.from_port == 5432 && r.to_port == 5432 && r.ip_protocol == "tcp"
    ])
    error_message = "ingress is TCP 5432 with no CIDR source"
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.endpoints_https[0].referenced_security_group_id == aws_security_group.lambda[0].id && aws_vpc_security_group_ingress_rule.endpoints_https[0].from_port == 443
    error_message = "endpoint ingress only from the Lambda security group"
  }
}

run "proxy_off" {
  command = apply
  variables {
    create_proxy = false
  }
  assert {
    condition     = output.proxy_host == null && output.proxy_resource_id == null
    error_message = "proxy outputs are null"
  }
  assert {
    condition     = length(aws_db_proxy.this) == 0 && length(aws_security_group.proxy) == 0 && length(aws_iam_role.proxy) == 0 && length(aws_vpc_security_group_ingress_rule.database_from_proxy) == 0
    error_message = "no proxy resources"
  }
}

run "bring_your_own_network" {
  command = apply
  variables {
    vpc_id                   = "vpc-0123456789abcdef0"
    subnet_ids               = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
    lambda_security_group_id = "sg-0123456789abcdef0"
  }
  assert {
    condition = (
      length(aws_vpc.this) == 0 && length(aws_subnet.private) == 0 &&
      length(aws_route_table.private) == 0 && length(aws_vpc_endpoint.gateway) == 0 &&
      length(aws_vpc_endpoint.interface) == 0 && length(aws_security_group.endpoints) == 0 &&
      length(aws_security_group.lambda) == 0
    )
    error_message = "bring-your-own creates no network resources"
  }
  assert {
    condition     = join(",", output.subnet_ids) == "subnet-0123456789abcdef0,subnet-0123456789abcdef1" && output.vpc_id == "vpc-0123456789abcdef0" && output.lambda_security_group_id == "sg-0123456789abcdef0"
    error_message = "given network is used"
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.database_from_lambda.referenced_security_group_id == "sg-0123456789abcdef0"
    error_message = "ingress references the supplied Lambda security group"
  }
}

run "bring_your_own_creates_lambda_sg" {
  command = apply
  variables {
    vpc_id     = "vpc-0123456789abcdef0"
    subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  }
  assert {
    condition     = length(aws_security_group.lambda) == 1 && length(aws_vpc.this) == 0 && length(aws_vpc_endpoint.interface) == 0
    error_message = "only the Lambda security group is created"
  }
  assert {
    condition     = aws_security_group.lambda[0].vpc_id == "vpc-0123456789abcdef0"
    error_message = "the Lambda security group lives in the given VPC"
  }
}

run "partial_byo_subnets_without_vpc" {
  command = plan
  variables {
    subnet_ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  }
  expect_failures = [aws_vpc.this]
}

run "partial_byo_sg_without_vpc" {
  command = plan
  variables {
    lambda_security_group_id = "sg-0123456789abcdef0"
  }
  expect_failures = [aws_vpc.this]
}

run "partial_byo_vpc_without_subnets" {
  command = plan
  variables {
    vpc_id = "vpc-0123456789abcdef0"
  }
  expect_failures = [aws_db_subnet_group.this]
}

run "partial_byo_single_subnet" {
  command = plan
  variables {
    vpc_id     = "vpc-0123456789abcdef0"
    subnet_ids = ["subnet-0123456789abcdef0"]
  }
  expect_failures = [aws_db_subnet_group.this]
}

run "rejects_bad_ids" {
  command = plan
  variables {
    vpc_id = "not-a-vpc"
  }
  expect_failures = [var.vpc_id]
}

run "extra_tags_merge" {
  command = apply
  variables {
    tags = { owner = "test" }
  }
  assert {
    condition     = aws_db_instance.this.tags["owner"] == "test" && aws_db_instance.this.tags["errtraq:fixture"] == "rds-postgres" && aws_vpc.this[0].tags["errtraq:fixture"] == "rds-postgres"
    error_message = "tags merge with the fixture tag"
  }
}
