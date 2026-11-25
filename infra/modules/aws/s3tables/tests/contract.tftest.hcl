mock_provider "aws" {
  mock_resource "aws_s3tables_table_bucket" {
    defaults = {
      arn = "arn:aws:s3tables:us-east-1:123456789012:bucket/example-archive"
    }
  }
  mock_data "aws_region" {
    defaults = {
      region = "us-east-1"
    }
  }
  mock_data "aws_partition" {
    defaults = {
      dns_suffix = "amazonaws.com"
    }
  }
}
run "bucket_namespace_and_policies" {
  command = apply
  variables {
    name = "Example"
    tags = { app = "errtraq" }
  }
  assert {
    condition     = aws_s3tables_table_bucket.this.name == "example-archive" && !aws_s3tables_table_bucket.this.force_destroy && jsonencode(aws_s3tables_table_bucket.this.tags) == jsonencode({ app = "errtraq" }) && aws_s3tables_table_bucket.this.encryption_configuration.sse_algorithm == "AES256" && aws_s3tables_table_bucket.this.encryption_configuration.kms_key_arn == null
    error_message = "The production table bucket must be named, tagged, SSE-S3 encrypted and not force-destroyable."
  }
  assert {
    condition     = aws_s3tables_table_bucket.this.maintenance_configuration.iceberg_unreferenced_file_removal.status == "enabled" && aws_s3tables_table_bucket.this.maintenance_configuration.iceberg_unreferenced_file_removal.settings.unreferenced_days == 3 && aws_s3tables_table_bucket.this.maintenance_configuration.iceberg_unreferenced_file_removal.settings.non_current_days == 10
    error_message = "Unreferenced file removal must be enabled with the service defaults."
  }
  assert {
    condition     = aws_s3tables_namespace.this.namespace == "errtraq" && aws_s3tables_namespace.this.table_bucket_arn == aws_s3tables_table_bucket.this.arn
    error_message = "The namespace must live in the table bucket."
  }
  assert {
    condition     = jsonencode(jsondecode(aws_s3tables_table_bucket_policy.tls.resource_policy)) == jsonencode({ Version = "2012-10-17", Statement = [{ Sid = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3tables:*", Resource = [aws_s3tables_table_bucket.this.arn, "${aws_s3tables_table_bucket.this.arn}/table/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
    error_message = "The table bucket must deny insecure transport."
  }
  assert {
    condition = jsonencode(jsondecode(output.policies.read.primary)) == jsonencode({ Version = "2012-10-17", Statement = [
      { Effect = "Allow", Action = ["s3tables:GetTableBucket", "s3tables:ListNamespaces", "s3tables:GetNamespace", "s3tables:ListTables"], Resource = aws_s3tables_table_bucket.this.arn },
      { Effect = "Allow", Action = ["s3tables:GetTable", "s3tables:GetTableMetadataLocation", "s3tables:GetTableData"], Resource = "${aws_s3tables_table_bucket.this.arn}/table/*" }
    ] })
    error_message = "The read policy must grant exactly the catalog read and data read actions."
  }
  assert {
    condition = jsonencode(jsondecode(output.policies.write.primary)) == jsonencode({ Version = "2012-10-17", Statement = [
      { Effect = "Allow", Action = ["s3tables:CreateTable"], Resource = aws_s3tables_table_bucket.this.arn },
      { Effect = "Allow", Action = ["s3tables:CreateTable", "s3tables:PutTableData", "s3tables:UpdateTableMetadataLocation"], Resource = "${aws_s3tables_table_bucket.this.arn}/table/*" }
    ] })
    error_message = "The write policy must grant table creation, data writes and metadata commits only."
  }
  assert {
    condition = jsonencode(jsondecode(output.policies.delete.primary)) == jsonencode({ Version = "2012-10-17", Statement = [
      { Effect = "Allow", Action = ["s3tables:PutTableData", "s3tables:UpdateTableMetadataLocation"], Resource = "${aws_s3tables_table_bucket.this.arn}/table/*" }
    ] })
    error_message = "The delete policy must carry the commit actions and no drop action."
  }
  assert {
    condition     = alltrue([for capability, policies in output.policies : alltrue([for statement in jsondecode(policies.primary).Statement : !anytrue([for action in statement.Action : contains(["s3tables:DeleteTable", "s3tables:DeleteNamespace", "s3tables:DeleteTableBucket", "s3tables:PutTableBucketPolicy", "s3tables:PutTableMaintenanceConfiguration", "s3tables:PutTableBucketMaintenanceConfiguration"], action) || action == "s3tables:*"])])])
    error_message = "No function policy may drop or reconfigure the table bucket."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["read", "write", "delete"]) && alltrue([for policies in values(output.policies) : toset(keys(policies)) == toset(["primary"]) && can(jsondecode(policies.primary)) && length(policies.primary) <= 1024])
    error_message = "Policy output shape, encoded-document leaves and the sizing budget must hold."
  }
  assert {
    condition     = output.catalog_uri == "https://s3tables.us-east-1.amazonaws.com/iceberg" && output.region == "us-east-1" && output.namespace == "errtraq" && output.table_bucket_name == "example-archive" && output.table_bucket_arn == aws_s3tables_table_bucket.this.arn
    error_message = "Catalog endpoint, region, namespace and warehouse outputs must match."
  }
  assert {
    condition     = jsondecode(output.table_maintenance) == { iceberg_compaction = { target_file_size_mb = 512, strategy = "auto" }, iceberg_snapshot_management = { min_snapshots_to_keep = 1, max_snapshot_age_hours = 120 } }
    error_message = "Table maintenance defaults must be exported."
  }
}
run "disposable_and_lowered_maintenance" {
  command = apply
  variables {
    name                           = "example"
    tags                           = {}
    protection                     = "disposable"
    namespace                      = "archive_ns"
    unreferenced_days              = 1
    non_current_days               = 1
    compaction_target_file_size_mb = 64
    compaction_strategy            = "binpack"
    snapshot_max_age_hours         = 1
    snapshot_min_to_keep           = 1
  }
  assert {
    condition     = aws_s3tables_table_bucket.this.force_destroy && aws_s3tables_namespace.this.namespace == "archive_ns"
    error_message = "A disposable stack must permit teardown and honor the namespace."
  }
  assert {
    condition     = aws_s3tables_table_bucket.this.maintenance_configuration.iceberg_unreferenced_file_removal.settings.unreferenced_days == 1 && aws_s3tables_table_bucket.this.maintenance_configuration.iceberg_unreferenced_file_removal.settings.non_current_days == 1
    error_message = "The documented one-day minimums must be accepted."
  }
  assert {
    condition     = jsondecode(output.table_maintenance).iceberg_compaction.target_file_size_mb == 64 && jsondecode(output.table_maintenance).iceberg_compaction.strategy == "binpack" && jsondecode(output.table_maintenance).iceberg_snapshot_management.max_snapshot_age_hours == 1
    error_message = "Lowered table maintenance settings must be exported."
  }
}
run "kms_encryption_grants_key_use" {
  command = apply
  variables {
    name          = "example"
    tags          = {}
    sse_algorithm = "aws:kms"
    kms_key_arn   = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  }
  assert {
    condition     = aws_s3tables_table_bucket.this.encryption_configuration.sse_algorithm == "aws:kms" && aws_s3tables_table_bucket.this.encryption_configuration.kms_key_arn == "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555"
    error_message = "The table bucket must use the customer-managed key."
  }
  assert {
    condition     = contains(jsondecode(output.policies.read.primary).Statement[2].Action, "kms:Decrypt") && !contains(jsondecode(output.policies.read.primary).Statement[2].Action, "kms:GenerateDataKey") && contains(jsondecode(output.policies.write.primary).Statement[2].Action, "kms:GenerateDataKey") && contains(jsondecode(output.policies.delete.primary).Statement[1].Action, "kms:GenerateDataKey")
    error_message = "Readers need only decrypt; writers need data keys too."
  }
}
run "kms_requires_key" {
  command = plan
  variables {
    name          = "example"
    tags          = {}
    sse_algorithm = "aws:kms"
  }
  expect_failures = [var.kms_key_arn]
}
run "rejects_uppercase_namespace" {
  command = plan
  variables {
    name      = "example"
    tags      = {}
    namespace = "Errtraq"
  }
  expect_failures = [var.namespace]
}
run "rejects_subminimum_maintenance" {
  command = plan
  variables {
    name              = "example"
    tags              = {}
    unreferenced_days = 0
  }
  expect_failures = [var.unreferenced_days]
}
run "rejects_oversized_compaction_target" {
  command = plan
  variables {
    name                           = "example"
    tags                           = {}
    compaction_target_file_size_mb = 1024
  }
  expect_failures = [var.compaction_target_file_size_mb]
}
run "rejects_undersized_compaction_target" {
  command = plan
  variables {
    name                           = "example"
    tags                           = {}
    compaction_target_file_size_mb = 32
  }
  expect_failures = [var.compaction_target_file_size_mb]
}
run "rejects_subminimum_snapshot_age" {
  command = plan
  variables {
    name                   = "example"
    tags                   = {}
    snapshot_max_age_hours = 0
  }
  expect_failures = [var.snapshot_max_age_hours]
}
