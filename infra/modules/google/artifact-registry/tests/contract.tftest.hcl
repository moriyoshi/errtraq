mock_provider "google" {}
run "repository" {
  command = apply
  variables {
    project_id     = "example-project"
    location       = "europe-west1"
    repository_id  = "errtraq"
    writer_members = ["serviceAccount:ci@example-project.iam.gserviceaccount.com"]
  }
  assert {
    condition     = output.repository_url == "europe-west1-docker.pkg.dev/example-project/errtraq" && google_artifact_registry_repository.this.format == "DOCKER" && google_artifact_registry_repository.this.docker_config[0].immutable_tags
    error_message = "The repository is a Docker repository with immutable tags at the expected path."
  }
  assert {
    condition     = length(google_artifact_registry_repository_iam_member.writer) == 1 && length(google_artifact_registry_repository_iam_member.reader) == 0 && alltrue([for member in values(google_artifact_registry_repository_iam_member.writer) : member.role == "roles/artifactregistry.writer"])
    error_message = "Only the listed members get repository-level writer access."
  }
}
run "reject_missing_location" {
  command = plan
  variables {
    project_id    = "example-project"
    location      = "eu"
    repository_id = "errtraq"
  }
  expect_failures = [var.location]
}
