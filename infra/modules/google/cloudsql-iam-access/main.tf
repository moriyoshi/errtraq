locals {
  parts    = split(":", var.instance_connection_name)
  instance = local.parts[length(local.parts) - 1]
  project  = join(":", slice(local.parts, 0, length(local.parts) - 2))
  condition = {
    title       = "errtraq Cloud SQL instance"
    description = "Limits the grant to the ${local.instance} instance."
    expression  = "resource.name == 'projects/${local.project}/instances/${local.instance}' && resource.type == 'sqladmin.googleapis.com/Instance'"
  }
  # The login permission, with the instance the platform module creates the per-function IAM
  # database users on (a database user is not an IAM resource, so it travels in the document).
  login = merge(
    {
      role      = "roles/cloudsql.instanceUser"
      resource  = "projects/${local.project}"
      condition = local.condition
    },
    var.database_user == null ? { iam_database_user = { project = local.project, instance = local.instance } } : {},
  )
  # The proxy socket and the Admin API need the client role as well.
  client = {
    role      = "roles/cloudsql.client"
    resource  = "projects/${local.project}"
    condition = local.condition
  }
  document = jsonencode(concat([local.login], var.transport == "unix-socket" ? [local.client] : []))
  # SQL privileges, not IAM, decide read, write and delete (as with RDS IAM): every capability has the same grant.
  policies = {
    read   = { primary = local.document }
    write  = { primary = local.document }
    delete = { primary = local.document }
  }
}
