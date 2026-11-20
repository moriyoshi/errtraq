output "ingest_url" {
  value       = local.role_urls.ingest
  description = "errtraq-type=string; errtraq-keys="
}
output "api_url" {
  value       = local.role_urls.api
  description = "errtraq-type=string; errtraq-keys="
}
