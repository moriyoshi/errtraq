output "bucket_name" {
  value       = aws_s3_bucket.this.id
  description = "errtraq-type=string; errtraq-keys="
}
output "bucket_arn" {
  value       = aws_s3_bucket.this.arn
  description = "errtraq-type=string; errtraq-keys="
}
output "staging_arn" {
  value       = "${aws_s3_bucket.this.arn}/${var.staging_prefix}*"
  description = "errtraq-type=string; errtraq-keys="
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,read.staging,write.primary,write.staging,delete.primary,delete.staging,list.primary,list.staging"
}
