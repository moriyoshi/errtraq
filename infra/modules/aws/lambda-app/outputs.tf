output "ingest_url" {
  value       = local.role_urls.ingest
  description = "Public ingest function URL, or an empty string when not exposed."
}
output "api_url" {
  value       = local.role_urls.api
  description = "Public API function URL, or an empty string when not exposed."
}
