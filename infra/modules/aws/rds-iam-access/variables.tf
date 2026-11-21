variable "resource_id" {
  type        = string
  description = "DbiResourceId, Aurora cluster resource ID, or RDS Proxy resource ID."
  validation {
    condition     = can(regex("^(db|cluster|prx)-[A-Za-z0-9]+$", var.resource_id))
    error_message = "resource_id must be a database, cluster, or proxy resource ID without wildcards."
  }
}
variable "database_user" {
  type        = string
  description = "Exact PostgreSQL database user authorized to connect."
  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_.@-]{0,62}$", var.database_user))
    error_message = "database_user must be a safe PostgreSQL user name without IAM wildcards."
  }
}
variable "region" {
  type        = string
  description = "AWS region containing the database or proxy."
  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$", var.region))
    error_message = "region must be an AWS region identifier."
  }
}
