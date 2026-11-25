output "bucket_name" {
  value       = google_storage_bucket.this.name
  description = "errtraq-type=string; errtraq-keys=; Private GCS bucket name"
}
output "bucket_id" {
  value       = google_storage_bucket.this.id
  description = "errtraq-type=string; errtraq-keys=; Private GCS bucket resource id"
}
output "policies" {
  value       = local.policies
  description = "errtraq-type=map(map(json-document)); errtraq-keys=read.primary,write.primary,delete.primary,list.primary; JSON binding documents ({ role, resource, condition? } lists) keyed by capability and resource purpose"
}
