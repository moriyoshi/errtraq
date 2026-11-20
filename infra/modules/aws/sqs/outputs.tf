output "queues" {
  value       = local.queues
  description = "errtraq-type=map(map(string)); errtraq-keys=*.arn,*.url; Physical queue ARNs and URLs keyed by queue identifier"
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=produce.*,consume.*; JSON-encoded capability policies keyed by resource purpose"
}
