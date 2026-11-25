resource "aws_s3_bucket" "this" {
  bucket_prefix = "${substr(lower(var.name), 0, 30)}-"
  tags          = var.tags
  force_destroy = var.protection == "disposable"
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
resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_policy" "tls" {
  bucket = aws_s3_bucket.this.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
    Resource  = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"],
    Condition = { Bool = { "aws:SecureTransport" = "false" } }
  }] })
  depends_on = [aws_s3_bucket_public_access_block.this]
}
resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration { status = "Disabled" }
}
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
  rule {
    id     = "abandoned-envelopes"
    status = "Enabled"
    filter { prefix = "envelopes/" }
    expiration { days = var.raw_retention_days }
  }
  # Versioning is disabled on this bucket (erasure must remove data, not retain old versions),
  # so expiration deletes the only copy and no noncurrent-version rule is needed.
  # Grouped-record claim checks. Keys are unique per publication and never reused, so age is a
  # safe expiry. The age must exceed SQS's 14-day maximum message retention; a message redriven
  # after expiry fails as poison and lands in the DLQ.
  rule {
    id     = "expired-record-claims"
    status = "Enabled"
    filter { prefix = "payloads/records/" }
    expiration { days = var.record_claim_retention_days }
  }
  # Orphaned overflow event payloads (payloads/<projectId>/...). Retention deletes the event
  # first and its blob second, so only a crash between the two leaves an orphan. The age is the
  # longest project retention plus a margin, so a live event's blob is never expired. Project
  # IDs are decimal digits, so one rule per leading digit covers every project while leaving
  # payloads/records/ to the rule above (an S3 prefix filter cannot exclude a sub-prefix).
  dynamic "rule" {
    for_each = toset(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"])
    content {
      id     = "orphaned-overflow-payloads-${rule.value}"
      status = "Enabled"
      filter { prefix = "payloads/${rule.value}" }
      expiration { days = var.max_event_retention_days + var.overflow_orphan_margin_days }
    }
  }
  # Uploaded sourcemap chunks (artifacts/chunks/<orgId>/<sha1>) are inputs to a synchronous
  # assembly that deletes them on success; this only collects chunks of uploads never assembled.
  rule {
    id     = "abandoned-artifact-chunks"
    status = "Enabled"
    filter { prefix = "artifacts/chunks/" }
    expiration { days = var.artifact_chunk_retention_days }
  }
}
locals {
  # `archive-overflow/` holds the archive worker's batch manifests (swept by archive housekeeping);
  # the staging prefix was dropped with write-ahead staging (D5).
  prefixes = { primary = ["envelopes/", "payloads/", "artifacts/", "archive-overflow/"] }
  policies = {
    for capability, actions in {
      read   = ["s3:GetObject"]
      write  = ["s3:PutObject", "s3:AbortMultipartUpload"]
      delete = ["s3:DeleteObject"]
      list   = ["s3:ListBucket"]
      } : capability => {
      for purpose, prefixes in local.prefixes : purpose => capability == "list" ? jsonencode({
        Version = "2012-10-17"
        Statement = [{
          Effect    = "Allow", Action = actions, Resource = aws_s3_bucket.this.arn,
          Condition = { StringLike = { "s3:prefix" = [for prefix in prefixes : "${prefix}*"] } }
        }]
        }) : capability == "read" ? jsonencode({
        Version = "2012-10-17"
        Statement = [
          { Effect = "Allow", Action = actions, Resource = [for prefix in prefixes : "${aws_s3_bucket.this.arn}/${prefix}*"] },
          { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.this.arn,
          Condition = { StringLike = { "s3:prefix" = [for prefix in prefixes : "${prefix}*"] } } }
        ]
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
