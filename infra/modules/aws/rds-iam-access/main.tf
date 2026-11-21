data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
locals {
  connect_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["rds-db:connect"]
      Resource = ["arn:${data.aws_partition.current.partition}:rds-db:${var.region}:${data.aws_caller_identity.current.account_id}:dbuser:${var.resource_id}/${var.database_user}"]
    }]
  })
}
