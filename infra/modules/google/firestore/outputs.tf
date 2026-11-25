output "database_id" {
  value       = google_firestore_database.this.name
  description = "errtraq-type=string; errtraq-keys=; Firestore database id"
}
output "project_id" {
  value       = var.project_id
  description = "errtraq-type=string; errtraq-keys=; Project that owns the database"
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,write.primary,delete.primary,metadata-delete.primary; JSON binding documents ({ role, resource, condition? } lists) keyed by capability and resource purpose"
}
