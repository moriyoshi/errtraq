variable "name" {
  type        = string
  description = "Stack name used as the table bucket name prefix."
  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]{0,39}$", var.name))
    error_message = "name must contain 1-40 letters, digits, or hyphens and start with a letter or digit."
  }
}
variable "tags" {
  type        = map(string)
  description = "Tags applied to supported resources."
  validation {
    condition     = alltrue([for key in keys(var.tags) : length(key) > 0 && length(key) <= 128 && !startswith(lower(key), "aws:")])
    error_message = "Tag keys must be nonempty, at most 128 characters, and not start with aws:."
  }
}
variable "protection" {
  type        = string
  description = "Production refuses to destroy a table bucket that still holds tables; disposable permits teardown with its contents."
  default     = "production"
  validation {
    condition     = contains(["production", "disposable"], var.protection)
    error_message = "protection must be production or disposable."
  }
}
variable "namespace" {
  type        = string
  description = "Iceberg namespace holding the events table. The table itself is created by the archive engine, not by Terraform."
  default     = "errtraq"
  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,254}$", var.namespace))
    error_message = "namespace must be 1-255 lowercase letters, digits or underscores and start with a letter (S3 Tables rejects uppercase)."
  }
}
variable "sse_algorithm" {
  type        = string
  description = "Default table bucket encryption: AES256 (SSE-S3) or aws:kms (requires kms_key_arn)."
  default     = "AES256"
  validation {
    condition     = contains(["AES256", "aws:kms"], var.sse_algorithm)
    error_message = "sse_algorithm must be AES256 or aws:kms."
  }
}
variable "kms_key_arn" {
  type        = string
  description = "Customer-managed key for aws:kms encryption. The key policy must also allow the S3 Tables maintenance principal; this module only grants the function roles."
  default     = null
  validation {
    condition     = (var.sse_algorithm == "aws:kms") == (var.kms_key_arn != null) && (var.kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[a-zA-Z0-9-]+$", var.kms_key_arn)))
    error_message = "kms_key_arn must be a KMS key ARN when sse_algorithm is aws:kms, and null otherwise."
  }
}
variable "unreferenced_days" {
  type        = number
  description = "Table bucket maintenance: days before an unreferenced file is marked noncurrent. The S3 Tables minimum is 1; the service default is 3."
  default     = 3
  validation {
    condition     = var.unreferenced_days >= 1 && floor(var.unreferenced_days) == var.unreferenced_days
    error_message = "unreferenced_days must be an integer of at least 1."
  }
}
variable "non_current_days" {
  type        = number
  description = "Table bucket maintenance: days a noncurrent file is retained before deletion. The S3 Tables minimum is 1; the service default is 10."
  default     = 10
  validation {
    condition     = var.non_current_days >= 1 && floor(var.non_current_days) == var.non_current_days
    error_message = "non_current_days must be an integer of at least 1."
  }
}
variable "compaction_target_file_size_mb" {
  type        = number
  description = "Target data file size for table compaction, 64 to 512 (the service default is 512). Table-level maintenance cannot be set here because the engine creates the table; this value is exported as table_maintenance for the step that does."
  default     = 512
  validation {
    condition     = var.compaction_target_file_size_mb >= 64 && var.compaction_target_file_size_mb <= 512 && floor(var.compaction_target_file_size_mb) == var.compaction_target_file_size_mb
    error_message = "compaction_target_file_size_mb must be an integer from 64 to 512."
  }
}
variable "compaction_strategy" {
  type        = string
  description = "Table compaction strategy exported in table_maintenance. Compaction can merge projects into one file; see the archive design before choosing sort or z-order."
  default     = "auto"
  validation {
    condition     = contains(["auto", "binpack", "sort", "z-order"], var.compaction_strategy)
    error_message = "compaction_strategy must be auto, binpack, sort or z-order."
  }
}
variable "snapshot_max_age_hours" {
  type        = number
  description = "Table snapshot management: maximum snapshot age in hours, exported in table_maintenance. The S3 Tables minimum is 1; the service default is 120. Bounds how long erased rows stay readable through time travel."
  default     = 120
  validation {
    condition     = var.snapshot_max_age_hours >= 1 && floor(var.snapshot_max_age_hours) == var.snapshot_max_age_hours
    error_message = "snapshot_max_age_hours must be an integer of at least 1."
  }
}
variable "snapshot_min_to_keep" {
  type        = number
  description = "Table snapshot management: minimum snapshots kept regardless of age, exported in table_maintenance. The S3 Tables minimum is 1 (also the service default)."
  default     = 1
  validation {
    condition     = var.snapshot_min_to_keep >= 1 && floor(var.snapshot_min_to_keep) == var.snapshot_min_to_keep
    error_message = "snapshot_min_to_keep must be an integer of at least 1."
  }
}
