output "host" {
  value = aws_db_instance.this.address
}
output "port" {
  value = aws_db_instance.this.port
}
output "proxy_host" {
  value = var.create_proxy ? aws_db_proxy.this[0].endpoint : null
}
output "db_resource_id" {
  value = aws_db_instance.this.resource_id
}
output "proxy_resource_id" {
  description = "The prx- ID taken from the proxy ARN (the rds-db:connect resource ID)."
  value       = var.create_proxy ? element(split(":", aws_db_proxy.this[0].arn), length(split(":", aws_db_proxy.this[0].arn)) - 1) : null
}
output "master_secret_arn" {
  value = aws_db_instance.this.master_user_secret[0].secret_arn
}
output "subnet_ids" {
  value = local.subnet_ids
}
output "lambda_security_group_id" {
  value = local.lambda_sg_id
}
output "vpc_id" {
  value = local.vpc_id
}
output "database_name" {
  value = var.database_name
}
