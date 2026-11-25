mock_provider "google" {}
run "database_indexes_and_policies" {
  command = apply
  variables {
    name       = "example"
    purpose    = "store"
    project_id = "example-project"
    location   = "europe-west1"
    labels     = { app = "errtraq" }
    composite_indexes = [
      { collection = "issues", fields = [{ field_path = "status", order = "ASCENDING" }, { field_path = "lastSeen", order = "DESCENDING" }] },
      { collection = "issues", fields = [{ field_path = "lastSeen", order = "DESCENDING" }] },
    ]
    field_exemptions = [{ collection = "issues", field = "data" }, { collection = "events", field = "payload" }]
  }
  assert {
    condition     = output.database_id == "example-store" && output.project_id == "example-project"
    error_message = "The database id derives from the stack and purpose."
  }
  assert {
    condition     = google_firestore_database.this.location_id == "europe-west1" && google_firestore_database.this.type == "FIRESTORE_NATIVE" && google_firestore_database.this.database_edition == "STANDARD" && google_firestore_database.this.delete_protection_state == "DELETE_PROTECTION_ENABLED" && google_firestore_database.this.deletion_policy == "ABANDON" && google_firestore_database.this.point_in_time_recovery_enablement == "POINT_IN_TIME_RECOVERY_DISABLED"
    error_message = "A production database is native Standard in the explicit location, delete-protected, abandoned on removal and keeps no point-in-time copies."
  }
  assert {
    condition     = length(google_firestore_index.composite) == 2 && alltrue([for index in values(google_firestore_index.composite) : index.query_scope == "COLLECTION" && index.collection == "issues" && index.database == "example-store"])
    error_message = "Every declared composite index must exist with collection scope."
  }
  assert {
    condition     = toset([for index in values(google_firestore_index.composite) : jsonencode([for field in index.fields : [field.field_path, field.order]])]) == toset([jsonencode([["status", "ASCENDING"], ["lastSeen", "DESCENDING"]]), jsonencode([["lastSeen", "DESCENDING"]])])
    error_message = "Index fields keep their paths and orders."
  }
  assert {
    condition     = toset(keys(google_firestore_field.configured)) == toset(["issues/data", "events/payload"]) && alltrue([for field in values(google_firestore_field.configured) : length(field.index_config) == 1 && length(field.ttl_config) == 0])
    error_message = "Exempted fields disable single-field indexing and carry no TTL."
  }
  assert {
    condition = toset(keys(google_project_iam_custom_role.capability)) == toset(["read", "write", "delete"]) && alltrue([
      toset(google_project_iam_custom_role.capability["read"].permissions) == toset(["datastore.databases.get", "datastore.entities.get", "datastore.entities.list"]),
      toset(google_project_iam_custom_role.capability["write"].permissions) == toset(["datastore.databases.get", "datastore.entities.create", "datastore.entities.update"]),
      toset(google_project_iam_custom_role.capability["delete"].permissions) == toset(["datastore.entities.delete"]),
    ])
    error_message = "Each capability role carries exactly its Firestore permissions."
  }
  assert {
    condition = alltrue([for capability, role in { read = "read", write = "write", delete = "delete", "metadata-delete" = "delete" } :
      jsonencode(jsondecode(output.policies[capability].primary)) == jsonencode([{
        role      = "projects/example-project/roles/example_fs_store_${role}"
        resource  = "projects/example-project"
        condition = { title = "errtraq example store database", description = "Limits the grant to the example-store database.", expression = "resource.name == \"projects/example-project/databases/example-store\"" }
      }])
    ])
    error_message = "Every binding document grants its role on this project only for this database."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["read", "write", "delete", "metadata-delete"]) && alltrue([for policies in values(output.policies) : toset(keys(policies)) == toset(["primary"]) && alltrue([for policy in values(policies) : can(jsondecode(policy))])])
    error_message = "Policy output shape must follow the descriptors of both Firestore adapters."
  }
}
run "kv_ttl" {
  command = apply
  variables {
    name         = "example"
    purpose      = "kv"
    project_id   = "example-project"
    location     = "europe-west1"
    ttl_policies = [{ collection = "kv", field = "expireAt" }]
  }
  assert {
    condition     = output.database_id == "example-kv" && length(google_firestore_index.composite) == 0
    error_message = "The KV database is its own database with no composite index."
  }
  assert {
    condition     = toset(keys(google_firestore_field.configured)) == toset(["kv/expireAt"]) && length(google_firestore_field.configured["kv/expireAt"].ttl_config) == 1 && length(google_firestore_field.configured["kv/expireAt"].index_config) == 0
    error_message = "The TTL field is declared as a TTL policy and stays indexed."
  }
  assert {
    condition     = jsondecode(output.policies.read.primary)[0].condition.expression == "resource.name == \"projects/example-project/databases/example-kv\""
    error_message = "KV grants are limited to the KV database."
  }
}
run "ttl_and_exemption_merge" {
  command = apply
  variables {
    name             = "example"
    purpose          = "kv"
    project_id       = "example-project"
    location         = "europe-west1"
    field_exemptions = [{ collection = "kv", field = "expireAt" }]
    ttl_policies     = [{ collection = "kv", field = "expireAt" }]
  }
  assert {
    condition     = length(google_firestore_field.configured) == 1 && length(google_firestore_field.configured["kv/expireAt"].ttl_config) == 1 && length(google_firestore_field.configured["kv/expireAt"].index_config) == 1
    error_message = "One field resource carries both settings."
  }
}
run "disposable_database" {
  command = apply
  variables {
    name        = "example"
    purpose     = "store"
    project_id  = "example-project"
    location    = "europe-west1"
    protection  = "disposable"
    database_id = "explicit-db"
  }
  assert {
    condition     = google_firestore_database.this.delete_protection_state == "DELETE_PROTECTION_DISABLED" && google_firestore_database.this.deletion_policy == "DELETE" && output.database_id == "explicit-db"
    error_message = "A disposable database may be deleted, and an explicit id is used verbatim."
  }
}
run "reject_missing_location" {
  command = plan
  variables {
    name       = "example"
    purpose    = "store"
    project_id = "example-project"
    location   = ""
  }
  expect_failures = [var.location]
}
run "reject_bad_index_order" {
  command = plan
  variables {
    name              = "example"
    purpose           = "store"
    project_id        = "example-project"
    location          = "europe-west1"
    composite_indexes = [{ collection = "issues", fields = [{ field_path = "status", order = "UP" }] }]
  }
  expect_failures = [var.composite_indexes]
}
