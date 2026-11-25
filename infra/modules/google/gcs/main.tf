# The project is the provider's (explicit in every generated root); it is never defaulted here.
data "google_client_config" "current" {}
locals {
  project = data.google_client_config.current.project
  # Deterministic so the binding documents are known at plan time; the project id keeps the
  # globally shared bucket namespace collision free.
  bucket_name = "${var.name}-${local.project}-blob"
  role_prefix = "${replace(var.name, "-", "_")}_blob"
  # Custom roles carry exactly the object permissions each capability needs (GCP_PLAN 5.2).
  # Overwriting an object needs delete as well as create, so write includes both.
  permissions = {
    read   = ["storage.objects.get"]
    list   = ["storage.objects.list"]
    write  = ["storage.objects.create", "storage.objects.delete"]
    delete = ["storage.objects.delete"]
  }
}
resource "google_storage_bucket" "this" {
  name                        = local.bucket_name
  project                     = local.project
  location                    = var.location
  labels                      = var.labels
  force_destroy               = var.protection == "disposable"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  # Versioning and soft delete are off so deleting an object (PII erasure) removes the only copy.
  versioning {
    enabled = false
  }
  soft_delete_policy {
    retention_duration_seconds = 0
  }
  lifecycle {
    precondition {
      condition     = can(regex("^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", local.bucket_name))
      error_message = "The derived bucket name must be a valid GCS bucket name (the project id must not contain a domain prefix)."
    }
  }
  lifecycle_rule {
    condition {
      age            = var.raw_retention_days
      matches_prefix = ["envelopes/"]
    }
    action {
      type = "Delete"
    }
  }
  # Grouped-record claim checks. Keys are unique per publication and never reused, so age is a safe expiry.
  lifecycle_rule {
    condition {
      age            = var.record_claim_retention_days
      matches_prefix = ["payloads/records/"]
    }
    action {
      type = "Delete"
    }
  }
  # Orphaned overflow event payloads (payloads/<projectId>/...). Project ids are decimal digits, so
  # one prefix per leading digit covers every project and leaves payloads/records/ to the rule above.
  lifecycle_rule {
    condition {
      age            = var.max_event_retention_days + var.overflow_orphan_margin_days
      matches_prefix = [for digit in range(10) : "payloads/${digit}"]
    }
    action {
      type = "Delete"
    }
  }
  # Sourcemap chunks that were uploaded but never assembled.
  lifecycle_rule {
    condition {
      age            = var.artifact_chunk_retention_days
      matches_prefix = ["artifacts/chunks/"]
    }
    action {
      type = "Delete"
    }
  }
}
resource "google_project_iam_custom_role" "capability" {
  for_each    = local.permissions
  project     = local.project
  role_id     = "${local.role_prefix}_${each.key}"
  title       = "errtraq ${var.name} blob ${each.key}"
  description = "Object permissions for the errtraq ${each.key} capability on the ${var.name} bucket."
  permissions = each.value
  stage       = "GA"
}
locals {
  # Binding documents: a JSON list of { role, resource } applied by the platform module. Resources are
  # bucket-level; uniform bucket-level access forbids per-object ACLs. The role name derives from
  # configured attributes, so the documents are known at plan time and order the grants after the roles.
  policies = {
    for capability in keys(local.permissions) : capability => {
      primary = jsonencode([{
        role     = "projects/${google_project_iam_custom_role.capability[capability].project}/roles/${google_project_iam_custom_role.capability[capability].role_id}"
        resource = "projects/_/buckets/${google_storage_bucket.this.name}"
      }])
    }
  }
}
