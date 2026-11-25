output "bucket_name" {
  value       = aws_s3_bucket.this.id
  description = "errtraq-type=string; errtraq-keys=; Private S3 bucket name"
}
output "bucket_arn" {
  value       = aws_s3_bucket.this.arn
  description = "errtraq-type=string; errtraq-keys=; Private S3 bucket ARN"
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,write.primary,delete.primary,list.primary; JSON-encoded capability policies keyed by resource purpose"
}
