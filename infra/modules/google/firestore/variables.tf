variable "name" {
  type        = string
  description = "Stack name used as the database id prefix."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,19}$", var.name))
    error_message = "name must be 1-20 lowercase letters, digits or hyphens and start with a letter."
  }
}
variable "purpose" {
  type        = string
  description = "What the database serves: store (the active store) or kv (rate counters and other ephemeral keys). Each purpose gets its own database so its access grants cannot reach the other."
  validation {
    condition     = contains(["store", "kv"], var.purpose)
    error_message = "purpose must be store or kv."
  }
}
variable "project_id" {
  type        = string
  description = "Project that owns the database. Required and never defaulted."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a GCP project id."
  }
}
variable "location" {
  type        = string
  description = "Firestore location (a region or multi-region id). Required and never defaulted: it is immutable after creation."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.location))
    error_message = "location must be a Firestore location id such as europe-west1."
  }
}
variable "database_id" {
  type        = string
  description = "Exact database id; null derives <name>-<purpose>."
  default     = null
  validation {
    condition     = var.database_id == null ? true : can(regex("^(\\(default\\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$", var.database_id))
    error_message = "database_id must be (default) or 4-63 lowercase letters, digits or hyphens starting with a letter."
  }
}
variable "labels" {
  type        = map(string)
  description = "Accepted for uniformity with the other modules. Firestore databases take no labels, so they are recorded in the output only."
  default     = {}
}
variable "protection" {
  type        = string
  description = "Production enables delete protection and abandons the database when removed from state; disposable permits teardown."
  default     = "production"
  validation {
    condition     = contains(["production", "disposable"], var.protection)
    error_message = "protection must be production or disposable."
  }
}
variable "composite_indexes" {
  type = list(object({
    collection = string
    fields = list(object({
      field_path = string
      order      = string
    }))
  }))
  description = "Composite indexes (collection scope). __name__ is implicit and follows the direction of the last field."
  default     = []
  validation {
    condition = alltrue([for index in var.composite_indexes :
      can(regex("^[A-Za-z][A-Za-z0-9_]*$", index.collection)) && length(index.fields) >= 1 &&
      alltrue([for field in index.fields : length(field.field_path) > 0 && contains(["ASCENDING", "DESCENDING"], field.order)])
    ])
    error_message = "Composite indexes need a collection id and at least one field with an ASCENDING or DESCENDING order."
  }
}
variable "field_exemptions" {
  type = list(object({
    collection = string
    field      = string
  }))
  description = "Fields exempted from all single-field indexing (large or opaque payloads)."
  default     = []
}
variable "ttl_policies" {
  type = list(object({
    collection = string
    field      = string
  }))
  description = "Fields whose timestamp values drive TTL deletion (deletion lags by up to a day; readers still check expiry)."
  default     = []
}
