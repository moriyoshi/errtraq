output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,write.primary,delete.primary; JSON binding documents ({ role, resource, condition?, iam_database_user? } lists); one instance-scoped login and client grant per capability"
}
