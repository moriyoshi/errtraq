# Optional and operator-owned (GCP_PLAN D12): image builds and pushes stay outside `terraform apply`,
# and the digest travels into the stack as a variable. Nothing in a generated root references this module.
resource "google_artifact_registry_repository" "this" {
  project       = var.project_id
  location      = var.location
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = "errtraq container images"
  labels        = var.labels
  # Digests, not tags, are what the stack pins; immutable tags keep a tag from moving under them.
  docker_config {
    immutable_tags = true
  }
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.keep_recent_versions
    }
  }
  cleanup_policies {
    id     = "delete-older"
    action = "DELETE"
    condition {
      tag_state = "ANY"
    }
  }
}
resource "google_artifact_registry_repository_iam_member" "writer" {
  for_each   = toset(var.writer_members)
  project    = google_artifact_registry_repository.this.project
  location   = google_artifact_registry_repository.this.location
  repository = google_artifact_registry_repository.this.name
  role       = "roles/artifactregistry.writer"
  member     = each.value
}
resource "google_artifact_registry_repository_iam_member" "reader" {
  for_each   = toset(var.reader_members)
  project    = google_artifact_registry_repository.this.project
  location   = google_artifact_registry_repository.this.location
  repository = google_artifact_registry_repository.this.name
  role       = "roles/artifactregistry.reader"
  member     = each.value
}
