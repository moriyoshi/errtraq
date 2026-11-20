output "bucket_name" { value = aws_s3_bucket.this.id }
output "bucket_arn" { value = aws_s3_bucket.this.arn }
output "staging_arn" { value = "${aws_s3_bucket.this.arn}/${var.staging_prefix}*" }
output "policies" { value = local.policies }
