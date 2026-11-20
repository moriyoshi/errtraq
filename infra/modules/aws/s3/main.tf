resource "aws_s3_bucket" "this" {
  bucket_prefix = "${substr(lower(var.name), 0, 30)}-"
  tags          = var.tags
}
resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
# Disabled rather than suspended/enabled: deletion for PII erasure removes the object,
# rather than retaining old versions. Recovery relies on application-level replication.
resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration { status = "Disabled" }
}
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    id     = "abandoned-envelopes"
    status = "Enabled"
    filter { prefix = "envelopes/" }
    expiration { days = var.raw_retention_days }
  }
  rule {
    id     = "abandoned-archive-staging"
    status = "Enabled"
    filter { prefix = var.staging_prefix }
    expiration { days = var.staging_retention_days }
  }
}
locals {
  # Keep primary grants out of the separate staging prefix.
  prefixes = { primary = ["envelopes/", "payloads/", "artifacts/"], staging = [var.staging_prefix] }
  policies = {
    for capability, actions in {
      read   = ["s3:GetObject"]
      write  = ["s3:PutObject"]
      delete = ["s3:DeleteObject"]
      list   = ["s3:ListBucket"]
      } : capability => {
      for purpose, prefixes in local.prefixes : purpose => capability == "list" ? jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect    = "Allow", Action = actions, Resource = aws_s3_bucket.this.arn,
          Condition = { StringLike = { "s3:prefix" = [for prefix in prefixes : "${prefix}*"] } }
        }]
        }) : jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect   = "Allow", Action = actions,
          Resource = [for prefix in prefixes : "${aws_s3_bucket.this.arn}/${prefix}*"]
        }]
      })
    }
  }
}
