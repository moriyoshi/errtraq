locals {
  database_id = coalesce(var.database_id, "${var.name}-${var.purpose}")
  role_prefix = "${replace(var.name, "-", "_")}_fs_${var.purpose}"
  production  = var.protection == "production"
  # google_firestore_field is one resource per (collection, field): an exemption and a TTL policy on
  # the same field are merged into one entry.
  fields = {
    for key in distinct(concat(
      [for item in var.field_exemptions : "${item.collection}/${item.field}"],
      [for item in var.ttl_policies : "${item.collection}/${item.field}"],
      )) : key => {
      collection = split("/", key)[0]
      field      = split("/", key)[1]
      exempt     = contains([for item in var.field_exemptions : "${item.collection}/${item.field}"], key)
      ttl        = contains([for item in var.ttl_policies : "${item.collection}/${item.field}"], key)
    }
  }
  # Indexes are keyed by their definition, not their position, so reordering the list never
  # replaces an index.
  indexes = {
    for index in var.composite_indexes :
    "${index.collection}|${join(",", [for field in index.fields : "${field.field_path}:${field.order}"])}" => index...
  }
  permissions = {
    # beginTransaction and rollback need only database metadata access.
    read   = ["datastore.databases.get", "datastore.entities.get", "datastore.entities.list"]
    write  = ["datastore.databases.get", "datastore.entities.create", "datastore.entities.update"]
    delete = ["datastore.entities.delete"]
  }
}
resource "google_firestore_database" "this" {
  project                           = var.project_id
  name                              = local.database_id
  location_id                       = var.location
  type                              = "FIRESTORE_NATIVE"
  database_edition                  = "STANDARD"
  concurrency_mode                  = "PESSIMISTIC"
  app_engine_integration_mode       = "DISABLED"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_DISABLED"
  delete_protection_state           = local.production ? "DELETE_PROTECTION_ENABLED" : "DELETE_PROTECTION_DISABLED"
  deletion_policy                   = local.production ? "ABANDON" : "DELETE"
}
resource "google_firestore_index" "composite" {
  for_each    = local.indexes
  project     = var.project_id
  database    = google_firestore_database.this.name
  collection  = each.value[0].collection
  query_scope = "COLLECTION"
  dynamic "fields" {
    for_each = each.value[0].fields
    content {
      field_path = fields.value.field_path
      order      = fields.value.order
    }
  }
  timeouts {
    create = "60m"
  }
}
resource "google_firestore_field" "configured" {
  for_each   = local.fields
  project    = var.project_id
  database   = google_firestore_database.this.name
  collection = each.value.collection
  field      = each.value.field
  # An empty index_config disables every single-field index for the field.
  dynamic "index_config" {
    for_each = each.value.exempt ? [1] : []
    content {}
  }
  dynamic "ttl_config" {
    for_each = each.value.ttl ? [1] : []
    content {}
  }
}
resource "google_project_iam_custom_role" "capability" {
  for_each    = local.permissions
  project     = var.project_id
  role_id     = "${local.role_prefix}_${each.key}"
  title       = "errtraq ${var.name} ${var.purpose} ${each.key}"
  description = "Firestore ${each.key} permissions for the errtraq ${var.name} ${var.purpose} database; bound with a database condition."
  permissions = each.value
  stage       = "GA"
}
locals {
  # Binding documents ({ role, resource, condition? } lists). Firestore data access is granted at
  # the project with a condition that names exactly this database, so the roles cannot reach
  # another database. There is no key-prefix narrowing, so key-read, project-read and release-read
  # collapse into read for the caller (documented loss).
  database_condition = {
    title       = "errtraq ${var.name} ${var.purpose} database"
    description = "Limits the grant to the ${local.database_id} database."
    expression  = "resource.name == \"projects/${var.project_id}/databases/${google_firestore_database.this.name}\""
  }
  document = { for capability, role in google_project_iam_custom_role.capability : capability => jsonencode([{
    role      = "projects/${role.project}/roles/${role.role_id}"
    resource  = "projects/${var.project_id}"
    condition = local.database_condition
  }]) }
  policies = {
    read              = { primary = local.document["read"] }
    write             = { primary = local.document["write"] }
    delete            = { primary = local.document["delete"] }
    "metadata-delete" = { primary = local.document["delete"] }
  }
}
