output "queues" {
  value       = local.queues
  description = "errtraq-type=map(map(string)); errtraq-keys=*.arn,*.url"
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=produce.*,consume.*"
}
