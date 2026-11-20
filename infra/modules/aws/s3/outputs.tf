output "bucket_name" {
  value       = aws_s3_bucket.this.id
  description = "errtraq-type=string; errtraq-keys=; Private S3 bucket name"
}
output "bucket_arn" {
  value       = aws_s3_bucket.this.arn
  description = "errtraq-type=string; errtraq-keys=; Private S3 bucket ARN"
}
output "staging_arn" {
  value       = "${aws_s3_bucket.this.arn}/${var.staging_prefix}*"
  description = "errtraq-type=string; errtraq-keys=; Archive staging object ARN prefix"
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,read.staging,write.primary,write.staging,delete.primary,delete.staging,list.primary,list.staging; JSON-encoded capability policies keyed by resource purpose"
}
