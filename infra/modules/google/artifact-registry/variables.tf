variable "project_id" {
  type        = string
  description = "Project that owns the repository. Required and never defaulted."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a GCP project id."
  }
}
variable "location" {
  type        = string
  description = "Repository location (a region). Required and never defaulted."
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.location))
    error_message = "location must be a region identifier such as europe-west1."
  }
}
variable "repository_id" {
  type        = string
  description = "Repository id for the container images `errtraq build` produces."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,61}[a-z0-9]$", var.repository_id))
    error_message = "repository_id must be 3-63 lowercase letters, digits or hyphens starting with a letter."
  }
}
variable "labels" {
  type        = map(string)
  description = "Labels applied to the repository."
  default     = {}
}
variable "keep_recent_versions" {
  type        = number
  description = "Number of most recent image versions kept by the cleanup policy; older versions are deleted."
  default     = 10
  validation {
    condition     = var.keep_recent_versions >= 1 && floor(var.keep_recent_versions) == var.keep_recent_versions
    error_message = "keep_recent_versions must be a positive integer."
  }
}
variable "writer_members" {
  type        = list(string)
  description = "IAM members (for example the CI service account) that push images (roles/artifactregistry.writer on this repository)."
  default     = []
}
variable "reader_members" {
  type        = list(string)
  description = "IAM members that pull images (roles/artifactregistry.reader on this repository). Cloud Run in the same project already pulls through its service agent."
  default     = []
}
