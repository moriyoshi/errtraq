# TEST FIXTURE ONLY. Not a product module; adapters must not reference it.
data "aws_availability_zones" "available" {
  state = "available"
}
data "aws_region" "current" {}
data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  create_network = var.vpc_id == null
  tags           = merge(var.tags, { "errtraq:fixture" = "rds-postgres" })
  azs            = slice(data.aws_availability_zones.available.names, 0, 2)
  vpc_id         = local.create_network ? aws_vpc.this[0].id : var.vpc_id
  subnet_ids     = local.create_network ? aws_subnet.private[*].id : var.subnet_ids
  lambda_sg_id   = var.lambda_security_group_id != null ? var.lambda_security_group_id : aws_security_group.lambda[0].id
  family         = "postgres${var.engine_version}"
}

# ---- network (created mode) ----
resource "aws_vpc" "this" {
  count                = local.create_network ? 1 : 0
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = var.name_prefix })
  lifecycle {
    precondition {
      condition     = length(var.subnet_ids) == 0 && var.lambda_security_group_id == null
      error_message = "subnet_ids and lambda_security_group_id require vpc_id; set all network inputs or none."
    }
  }
}
resource "aws_subnet" "private" {
  count             = local.create_network ? 2 : 0
  vpc_id            = aws_vpc.this[0].id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone = local.azs[count.index]
  tags              = merge(local.tags, { Name = "${var.name_prefix}-private-${count.index}" })
}
resource "aws_route_table" "private" {
  count  = local.create_network ? 1 : 0
  vpc_id = aws_vpc.this[0].id
  tags   = merge(local.tags, { Name = "${var.name_prefix}-private" })
}
resource "aws_route_table_association" "private" {
  count          = local.create_network ? 2 : 0
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[0].id
}
resource "aws_vpc_endpoint" "gateway" {
  for_each          = local.create_network ? toset(["s3", "dynamodb"]) : toset([])
  vpc_id            = aws_vpc.this[0].id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private[0].id]
  tags              = merge(local.tags, { Name = "${var.name_prefix}-${each.key}" })
}
resource "aws_security_group" "endpoints" {
  count       = local.create_network ? 1 : 0
  name        = "${var.name_prefix}-endpoints"
  description = "Interface endpoints: HTTPS from the Lambda security group"
  vpc_id      = aws_vpc.this[0].id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-endpoints" })
}
resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  count                        = local.create_network ? 1 : 0
  security_group_id            = aws_security_group.endpoints[0].id
  referenced_security_group_id = local.lambda_sg_id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the Lambda security group"
  tags                         = local.tags
}
resource "aws_vpc_endpoint" "interface" {
  for_each            = local.create_network ? toset(["sqs", "secretsmanager"]) : toset([])
  vpc_id              = aws_vpc.this[0].id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "${var.name_prefix}-${each.key}" })
}

# ---- security groups ----
resource "aws_security_group" "lambda" {
  count       = var.lambda_security_group_id == null ? 1 : 0
  name        = "${var.name_prefix}-lambda"
  description = "Lambda functions under test"
  vpc_id      = local.vpc_id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-lambda" })
}
resource "aws_vpc_security_group_egress_rule" "lambda_https" {
  count             = var.lambda_security_group_id == null ? 1 : 0
  security_group_id = aws_security_group.lambda[0].id
  cidr_ipv4         = local.create_network ? var.vpc_cidr : "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to endpoints or NAT"
  tags              = local.tags
}
resource "aws_vpc_security_group_egress_rule" "lambda_postgres" {
  count             = var.lambda_security_group_id == null ? 1 : 0
  security_group_id = aws_security_group.lambda[0].id
  cidr_ipv4         = local.create_network ? var.vpc_cidr : "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  description       = "PostgreSQL to the database or proxy"
  tags              = local.tags
}
resource "aws_vpc_security_group_egress_rule" "lambda_s3" {
  count             = var.lambda_security_group_id == null && local.create_network ? 1 : 0
  security_group_id = aws_security_group.lambda[0].id
  prefix_list_id    = aws_vpc_endpoint.gateway["s3"].prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "S3 gateway endpoint"
  tags              = local.tags
}
resource "aws_vpc_security_group_egress_rule" "lambda_dynamodb" {
  count             = var.lambda_security_group_id == null && local.create_network ? 1 : 0
  security_group_id = aws_security_group.lambda[0].id
  prefix_list_id    = aws_vpc_endpoint.gateway["dynamodb"].prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "DynamoDB gateway endpoint"
  tags              = local.tags
}

resource "aws_security_group" "database" {
  name        = "${var.name_prefix}-db"
  description = "PostgreSQL: 5432 from the Lambda and proxy security groups only"
  vpc_id      = local.vpc_id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-db" })
}
resource "aws_vpc_security_group_ingress_rule" "database_from_lambda" {
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = local.lambda_sg_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the Lambda security group"
  tags                         = local.tags
}
resource "aws_vpc_security_group_ingress_rule" "database_from_proxy" {
  count                        = var.create_proxy ? 1 : 0
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.proxy[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the proxy security group"
  tags                         = local.tags
}
resource "aws_security_group" "proxy" {
  count       = var.create_proxy ? 1 : 0
  name        = "${var.name_prefix}-proxy"
  description = "RDS Proxy: 5432 from the Lambda security group only"
  vpc_id      = local.vpc_id
  tags        = merge(local.tags, { Name = "${var.name_prefix}-proxy" })
}
resource "aws_vpc_security_group_ingress_rule" "proxy_from_lambda" {
  count                        = var.create_proxy ? 1 : 0
  security_group_id            = aws_security_group.proxy[0].id
  referenced_security_group_id = local.lambda_sg_id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from the Lambda security group"
  tags                         = local.tags
}
resource "aws_vpc_security_group_egress_rule" "proxy_to_database" {
  count                        = var.create_proxy ? 1 : 0
  security_group_id            = aws_security_group.proxy[0].id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL to the database"
  tags                         = local.tags
}

# ---- database ----
resource "aws_db_subnet_group" "this" {
  name       = var.name_prefix
  subnet_ids = local.subnet_ids
  tags       = local.tags
  lifecycle {
    precondition {
      condition     = local.create_network || (var.vpc_id != null && length(var.subnet_ids) >= 2)
      error_message = "Bring-your-own network needs vpc_id and at least two subnet_ids (partial network inputs are rejected)."
    }
  }
}
resource "aws_db_parameter_group" "this" {
  name_prefix = "${var.name_prefix}-"
  family      = local.family
  description = "errtraq test fixture: TLS required"
  tags        = local.tags
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  lifecycle {
    create_before_destroy = true
  }
}
resource "aws_db_instance" "this" {
  identifier                          = var.name_prefix
  engine                              = "postgres"
  engine_version                      = var.engine_version
  instance_class                      = var.instance_class
  allocated_storage                   = var.allocated_storage
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_name                             = var.database_name
  username                            = "errtraq_admin"
  manage_master_user_password         = true
  iam_database_authentication_enabled = true
  multi_az                            = false
  publicly_accessible                 = false
  db_subnet_group_name                = aws_db_subnet_group.this.name
  vpc_security_group_ids              = [aws_security_group.database.id]
  parameter_group_name                = aws_db_parameter_group.this.name
  backup_retention_period             = 0
  deletion_protection                 = false
  skip_final_snapshot                 = true
  auto_minor_version_upgrade          = false
  apply_immediately                   = true
  tags                                = local.tags
}

# ---- proxy ----
data "aws_iam_policy_document" "proxy_assume" {
  count = var.create_proxy ? 1 : 0
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}
data "aws_iam_policy_document" "proxy_secret" {
  count = var.create_proxy ? 1 : 0
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.this.master_user_secret[0].secret_arn]
  }
  # End-to-end IAM authentication: the proxy itself logs in to the instance as the IAM user.
  statement {
    actions   = ["rds-db:connect"]
    resources = ["arn:${data.aws_partition.current.partition}:rds-db:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:dbuser:${aws_db_instance.this.resource_id}/*"]
  }
}
resource "aws_iam_role" "proxy" {
  count              = var.create_proxy ? 1 : 0
  name               = "${var.name_prefix}-proxy"
  assume_role_policy = data.aws_iam_policy_document.proxy_assume[0].json
  tags               = local.tags
}
resource "aws_iam_role_policy" "proxy_secret" {
  count  = var.create_proxy ? 1 : 0
  name   = "master-secret"
  role   = aws_iam_role.proxy[0].id
  policy = data.aws_iam_policy_document.proxy_secret[0].json
}
resource "aws_db_proxy" "this" {
  count                  = var.create_proxy ? 1 : 0
  name                   = var.name_prefix
  engine_family          = "POSTGRESQL"
  require_tls            = true
  default_auth_scheme    = "IAM_AUTH"
  idle_client_timeout    = 1800
  role_arn               = aws_iam_role.proxy[0].arn
  vpc_subnet_ids         = local.subnet_ids
  vpc_security_group_ids = [aws_security_group.proxy[0].id]
  tags                   = local.tags
  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "REQUIRED"
    secret_arn  = aws_db_instance.this.master_user_secret[0].secret_arn
  }
  depends_on = [aws_iam_role_policy.proxy_secret]
}
resource "aws_db_proxy_default_target_group" "this" {
  count         = var.create_proxy ? 1 : 0
  db_proxy_name = aws_db_proxy.this[0].name
  connection_pool_config {
    max_connections_percent = 100
  }
}
resource "aws_db_proxy_target" "this" {
  count                  = var.create_proxy ? 1 : 0
  db_proxy_name          = aws_db_proxy.this[0].name
  target_group_name      = aws_db_proxy_default_target_group.this[0].name
  db_instance_identifier = aws_db_instance.this.identifier
}
