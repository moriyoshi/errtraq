variable "instance_connection_name" {
  type        = string
  description = "Existing instance as project:region:instance (a domain-scoped project adds a leading part). The module never creates an instance."
  validation {
    condition     = can(regex("^([a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z]+(-[a-z]+)?[0-9]+(-[a-z0-9]+)*:[a-z][a-z0-9-]{0,96}$", var.instance_connection_name))
    error_message = "instance_connection_name must be project:region:instance."
  }
}
variable "region" {
  type        = string
  description = "Region of the instance. Required and never defaulted; it must equal the region in the connection name."
  validation {
    condition     = can(regex("^[a-z]+(-[a-z]+)?[0-9]+(-[a-z0-9]+)*$", var.region))
    error_message = "region must be a GCP region identifier."
  }
  validation {
    condition     = can(regex(":${var.region}:[^:]+$", var.instance_connection_name))
    error_message = "region must match the region in instance_connection_name."
  }
}
variable "transport" {
  type        = string
  description = "unix-socket (the Cloud Run built-in proxy, needs roles/cloudsql.client) or tcp (direct connection with an IAM token, login only)."
  default     = "unix-socket"
  validation {
    condition     = contains(["unix-socket", "tcp"], var.transport)
    error_message = "transport must be unix-socket or tcp."
  }
}
variable "database_user" {
  type        = string
  description = "Operator-managed database user shared by every function (a configured serviceAccountEmail). When null, the platform module creates one IAM database user per function service account."
  default     = null
  validation {
    condition     = var.database_user == null ? true : can(regex("^[A-Za-z_][A-Za-z0-9_.@-]{0,62}$", var.database_user))
    error_message = "database_user must be a safe PostgreSQL user name."
  }
}
