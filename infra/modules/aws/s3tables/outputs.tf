output "table_bucket_arn" {
  value       = aws_s3tables_table_bucket.this.arn
  description = "errtraq-type=string; errtraq-keys=; S3 Tables table bucket ARN, the Iceberg warehouse identifier"
}
output "table_bucket_name" {
  value       = aws_s3tables_table_bucket.this.name
  description = "errtraq-type=string; errtraq-keys=; S3 Tables table bucket name"
}
output "namespace" {
  value       = aws_s3tables_namespace.this.namespace
  description = "errtraq-type=string; errtraq-keys=; Iceberg namespace that holds the events table"
}
output "region" {
  value       = data.aws_region.current.region
  description = "errtraq-type=string; errtraq-keys=; Region of the table bucket and the SigV4 signing region"
}
output "catalog_uri" {
  value       = "https://s3tables.${data.aws_region.current.region}.${data.aws_partition.current.dns_suffix}/iceberg"
  description = "errtraq-type=string; errtraq-keys=; S3 Tables Iceberg REST catalog base URI (signing name s3tables)"
}
output "table_maintenance" {
  value = jsonencode({
    iceberg_compaction = {
      target_file_size_mb = var.compaction_target_file_size_mb
      strategy            = var.compaction_strategy
    }
    iceberg_snapshot_management = {
      min_snapshots_to_keep  = var.snapshot_min_to_keep
      max_snapshot_age_hours = var.snapshot_max_age_hours
    }
  })
  description = "errtraq-type=json-document; errtraq-keys=; Table-level maintenance settings for the engine-created events table (not applied by Terraform)"
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,write.primary,delete.primary; JSON-encoded capability policies keyed by resource purpose"
}
