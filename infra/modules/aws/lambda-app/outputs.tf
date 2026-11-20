output "ingest_url" {
  value       = local.role_urls.ingest
  description = "errtraq-type=string; errtraq-keys=; Ingest function URL or an empty string when unexposed"
}
output "api_url" {
  value       = local.role_urls.api
  description = "errtraq-type=string; errtraq-keys=; API function URL or an empty string when unexposed"
}
