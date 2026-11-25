# The table bucket and namespace are Terraform-owned. The `events` table is deliberately NOT: the
# archive engine's ensureTable creates it with the format version, partition spec and sort order
# (a Terraform aws_s3tables_table cannot express them), and a table created here with only a
# schema would be adopted with the wrong layout. Consequently table-level maintenance (compaction,
# snapshot management) cannot be configured here and stays at the S3 Tables defaults until the
# engine or an operator step applies `table_maintenance`. TODO(M4l): apply table_maintenance.
data "aws_region" "current" {}
data "aws_partition" "current" {}

resource "aws_s3tables_table_bucket" "this" {
  name          = "${lower(var.name)}-archive"
  force_destroy = var.protection == "disposable"
  tags          = var.tags
  encryption_configuration = {
    sse_algorithm = var.sse_algorithm
    kms_key_arn   = var.kms_key_arn
  }
  # S3 Tables supports only unreferenced file removal at the bucket level.
  maintenance_configuration = {
    iceberg_unreferenced_file_removal = {
      status = "enabled"
      settings = {
        unreferenced_days = var.unreferenced_days
        non_current_days  = var.non_current_days
      }
    }
  }
}
resource "aws_s3tables_namespace" "this" {
  namespace        = var.namespace
  table_bucket_arn = aws_s3tables_table_bucket.this.arn
}
resource "aws_s3tables_table_bucket_policy" "tls" {
  table_bucket_arn = aws_s3tables_table_bucket.this.arn
  resource_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3tables:*",
    Resource  = [aws_s3tables_table_bucket.this.arn, "${aws_s3tables_table_bucket.this.arn}/table/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
}
locals {
  bucket_arn = aws_s3tables_table_bucket.this.arn
  tables_arn = "${aws_s3tables_table_bucket.this.arn}/table/*"
  # Actions per capability, split by the resource they authorize on. Iceberg REST traffic observed
  # in the spike (GetTableBucket, ListNamespaces, GetTableMetadataLocation,
  # UpdateTableMetadataLocation) plus the data-plane actions the commit and read paths need.
  # DeleteTable, DeleteNamespace, DeleteTableBucket and the maintenance and policy actions are
  # granted to no function role: dropping or reconfiguring is an operator action. A row delete
  # and a snapshot expiry are metadata commits (deletion vectors are written as table data), so
  # `delete` carries the commit actions rather than a drop.
  actions = {
    read = {
      bucket = ["s3tables:GetTableBucket", "s3tables:ListNamespaces", "s3tables:GetNamespace", "s3tables:ListTables"]
      table  = ["s3tables:GetTable", "s3tables:GetTableMetadataLocation", "s3tables:GetTableData"]
    }
    write = {
      bucket = ["s3tables:CreateTable"]
      table  = ["s3tables:CreateTable", "s3tables:PutTableData", "s3tables:UpdateTableMetadataLocation"]
    }
    delete = {
      bucket = []
      table  = ["s3tables:PutTableData", "s3tables:UpdateTableMetadataLocation"]
    }
  }
  kms_actions = {
    read   = ["kms:Decrypt"]
    write  = ["kms:Decrypt", "kms:GenerateDataKey"]
    delete = ["kms:Decrypt", "kms:GenerateDataKey"]
  }
  policies = {
    for capability, scoped in local.actions : capability => {
      primary = jsonencode({
        Version = "2012-10-17"
        Statement = concat(
          length(scoped.bucket) == 0 ? [] : [{ Effect = "Allow", Action = scoped.bucket, Resource = local.bucket_arn }],
          [{ Effect = "Allow", Action = scoped.table, Resource = local.tables_arn }],
          var.kms_key_arn == null ? [] : [{ Effect = "Allow", Action = local.kms_actions[capability], Resource = var.kms_key_arn }],
        )
      })
    }
  }
}
