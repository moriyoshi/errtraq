output "queues" {
  value       = local.queues
  description = "errtraq-type=map(map(string)); errtraq-keys=*.topic,*.subscription,*.dlq_topic,*.dlq_subscription; Full resource names per physical queue; subscription is reserved for the platform module and dlq_topic is empty without a dead-letter queue"
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=produce.*,consume.*; JSON binding documents ({ role, resource, condition? } lists) keyed by capability and physical queue"
}
