output "table_name" {
  value       = aws_dynamodb_table.this.name
  description = "errtraq-type=string; errtraq-keys="
}
output "table_arn" {
  value       = aws_dynamodb_table.this.arn
  description = "errtraq-type=string; errtraq-keys="
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,write.primary,delete.primary"
}
