locals {
  role_urls = {
    for role in ["ingest", "api", "bootstrap"] : role => one([
      for id, fn in var.functions : google_cloud_run_v2_service.function[id].uri if contains(role == "bootstrap" ? fn.roles : fn.http, role)
    ])
  }
}
output "ingest_url" {
  value       = local.role_urls["ingest"] == null ? "" : local.role_urls["ingest"]
  description = "errtraq-type=string; errtraq-keys=; Public ingest service URL, empty without an ingest function"
}
output "api_url" {
  value       = local.role_urls["api"] == null ? "" : local.role_urls["api"]
  description = "errtraq-type=string; errtraq-keys=; Public API service URL, empty without an API function"
}
output "bootstrap_url" {
  value       = local.role_urls["bootstrap"] == null ? "" : local.role_urls["bootstrap"]
  description = "errtraq-type=string; errtraq-keys=; Authenticated bootstrap service URL (invoke with an identity token), empty without a bootstrap function"
}
output "service_account_emails" {
  value       = { for id, account in google_service_account.function : id => account.email }
  description = "errtraq-type=map(string); errtraq-keys=; Runtime service account email per function id"
}
