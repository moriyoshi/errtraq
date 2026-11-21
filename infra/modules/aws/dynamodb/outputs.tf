output "table_name" {
  value       = aws_dynamodb_table.this.name
  description = "errtraq-type=string; errtraq-keys=; DynamoDB table name for runtime bindings"
}
output "table_arn" {
  value       = aws_dynamodb_table.this.arn
  description = "errtraq-type=string; errtraq-keys=; DynamoDB table ARN"
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,write.primary,delete.primary,metadata-delete.primary; JSON-encoded capability policies keyed by resource purpose"
}
