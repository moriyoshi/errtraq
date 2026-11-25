mock_provider "google" {
  mock_data "google_client_config" { defaults = { project = "example-project" } }
}
run "policies_and_lifecycle" {
  command = apply
  variables {
    name     = "example"
    location = "europe-west1"
  }
  assert {
    condition     = output.bucket_name == "example-example-project-blob" && google_storage_bucket.this.location == "europe-west1"
    error_message = "The bucket name derives from the stack and project, and the location is the explicit input."
  }
  assert {
    condition     = google_storage_bucket.this.uniform_bucket_level_access && google_storage_bucket.this.public_access_prevention == "enforced" && !google_storage_bucket.this.force_destroy && !google_storage_bucket.this.versioning[0].enabled && google_storage_bucket.this.soft_delete_policy[0].retention_duration_seconds == 0
    error_message = "The bucket must block public access, use uniform access, keep no versions or soft-deleted copies and refuse forced destruction in production."
  }
  assert {
    condition = toset(keys(google_project_iam_custom_role.capability)) == toset(["read", "list", "write", "delete"]) && alltrue([
      toset(google_project_iam_custom_role.capability["read"].permissions) == toset(["storage.objects.get"]),
      toset(google_project_iam_custom_role.capability["list"].permissions) == toset(["storage.objects.list"]),
      toset(google_project_iam_custom_role.capability["write"].permissions) == toset(["storage.objects.create", "storage.objects.delete"]),
      toset(google_project_iam_custom_role.capability["delete"].permissions) == toset(["storage.objects.delete"]),
    ])
    error_message = "Each capability role must carry exactly its object permissions."
  }
  assert {
    condition = alltrue([for capability in ["read", "write", "delete", "list"] :
      jsonencode(jsondecode(output.policies[capability].primary)) == jsonencode([{ role = "projects/example-project/roles/example_blob_${capability}", resource = "projects/_/buckets/example-example-project-blob" }])
    ])
    error_message = "Every binding document must grant its own custom role on exactly this bucket, with no condition."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["read", "write", "delete", "list"]) && alltrue([for policies in values(output.policies) : toset(keys(policies)) == toset(["primary"]) && alltrue([for policy in values(policies) : can(jsondecode(policy))])])
    error_message = "Policy output shape and encoded-document leaves must match the descriptor."
  }
}
run "lifecycle_rules" {
  command = apply
  variables {
    name     = "example"
    location = "europe-west1"
  }
  assert {
    condition = alltrue([
      one([for rule in google_storage_bucket.this.lifecycle_rule : one(rule.condition).age if toset(one(rule.condition).matches_prefix) == toset(["envelopes/"])]) == 14,
      one([for rule in google_storage_bucket.this.lifecycle_rule : one(rule.condition).age if toset(one(rule.condition).matches_prefix) == toset(["payloads/records/"])]) == 30,
      one([for rule in google_storage_bucket.this.lifecycle_rule : one(rule.condition).age if toset(one(rule.condition).matches_prefix) == toset(["artifacts/chunks/"])]) == 7,
      one([for rule in google_storage_bucket.this.lifecycle_rule : one(rule.condition).age if length(one(rule.condition).matches_prefix) == 10]) == 37,
    ])
    error_message = "Envelopes, record claims, sourcemap chunks and orphaned payloads must expire after 14, 30, 7 and 37 days."
  }
  assert {
    condition     = alltrue([for rule in google_storage_bucket.this.lifecycle_rule : one(rule.action).type == "Delete"])
    error_message = "Lifecycle rules only delete."
  }
  assert {
    condition     = toset(one([for rule in google_storage_bucket.this.lifecycle_rule : one(rule.condition).matches_prefix if length(one(rule.condition).matches_prefix) == 10])) == toset([for digit in range(10) : "payloads/${digit}"])
    error_message = "Orphan expiry covers each leading project id digit and leaves payloads/records/ to the claim rule."
  }
}
run "disposable_buckets_force_destroy" {
  command = apply
  variables {
    name       = "example"
    location   = "europe-west1"
    protection = "disposable"
  }
  assert {
    condition     = google_storage_bucket.this.force_destroy
    error_message = "A disposable bucket may be torn down with its objects."
  }
}
run "retention_inputs" {
  command = apply
  variables {
    name                        = "example"
    location                    = "europe-west1"
    raw_retention_days          = 3
    max_event_retention_days    = 10
    overflow_orphan_margin_days = 2
  }
  assert {
    condition     = one([for rule in google_storage_bucket.this.lifecycle_rule : one(rule.condition).age if length(one(rule.condition).matches_prefix) == 10]) == 12 && one([for rule in google_storage_bucket.this.lifecycle_rule : one(rule.condition).age if one(rule.condition).matches_prefix[0] == "envelopes/"]) == 3
    error_message = "Retention inputs must reach the lifecycle rules."
  }
}
run "reject_short_claim_retention" {
  command = plan
  variables {
    name                        = "example"
    location                    = "europe-west1"
    record_claim_retention_days = 7
  }
  expect_failures = [var.record_claim_retention_days]
}
run "reject_multi_region_or_missing_location" {
  command = plan
  variables {
    name     = "example"
    location = "EU"
  }
  expect_failures = [var.location]
}
