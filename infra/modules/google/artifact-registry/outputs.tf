output "repository_url" {
  value       = "${google_artifact_registry_repository.this.location}-docker.pkg.dev/${google_artifact_registry_repository.this.project}/${google_artifact_registry_repository.this.repository_id}"
  description = "errtraq-type=string; errtraq-keys=; Registry path to push images to, without an image name"
}
output "repository_id" {
  value       = google_artifact_registry_repository.this.id
  description = "errtraq-type=string; errtraq-keys=; Repository resource id"
}
