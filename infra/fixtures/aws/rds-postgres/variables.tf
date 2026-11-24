variable "name_prefix" {
  type        = string
  description = "Short prefix for every resource name."
  default     = "errtraq-fx"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 3 to 22 lowercase letters, digits or hyphens, starting with a letter."
  }
}
variable "tags" {
  type        = map(string)
  description = "Extra tags merged into every taggable resource."
  default     = {}
}
variable "instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.t4g.micro"
  validation {
    condition     = can(regex("^db\\.[a-z0-9]+\\.[a-z0-9]+$", var.instance_class))
    error_message = "instance_class must look like db.t4g.micro."
  }
}
variable "engine_version" {
  type        = string
  description = "PostgreSQL major version (the parameter group family is derived from it)."
  default     = "17"
  validation {
    condition     = can(regex("^[0-9]{2}$", var.engine_version))
    error_message = "engine_version must be a two-digit PostgreSQL major version."
  }
}
variable "database_name" {
  type        = string
  description = "Initial database name."
  default     = "errtraq"
  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.database_name))
    error_message = "database_name must be a lowercase PostgreSQL identifier."
  }
}
variable "allocated_storage" {
  type        = number
  description = "Allocated storage in GiB."
  default     = 20
  validation {
    condition     = var.allocated_storage >= 20 && var.allocated_storage <= 100
    error_message = "allocated_storage must be between 20 and 100 GiB for a test fixture."
  }
}
variable "create_proxy" {
  type        = bool
  description = "Create an RDS Proxy in front of the instance."
  default     = true
}
variable "vpc_cidr" {
  type        = string
  description = "CIDR of the created VPC (created mode only)."
  default     = "10.77.0.0/16"
  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be a valid CIDR no smaller than /20."
  }
}
variable "vpc_id" {
  type        = string
  description = "Existing VPC ID (bring-your-own mode). Null creates the network."
  default     = null
  validation {
    condition     = var.vpc_id == null ? true : can(regex("^vpc-([a-f0-9]{8}|[a-f0-9]{17})$", var.vpc_id))
    error_message = "vpc_id must be null or a valid VPC ID."
  }
}
variable "subnet_ids" {
  type        = list(string)
  description = "Existing subnet IDs in at least two AZs (bring-your-own mode)."
  default     = []
  validation {
    condition     = length(var.subnet_ids) <= 16 && alltrue([for id in var.subnet_ids : can(regex("^subnet-([a-f0-9]{8}|[a-f0-9]{17})$", id))])
    error_message = "Provide up to 16 valid subnet IDs."
  }
}
variable "lambda_security_group_id" {
  type        = string
  description = "Existing Lambda security group (bring-your-own mode). Null creates one in the given VPC."
  default     = null
  validation {
    condition     = var.lambda_security_group_id == null ? true : can(regex("^sg-([a-f0-9]{8}|[a-f0-9]{17})$", var.lambda_security_group_id))
    error_message = "lambda_security_group_id must be null or a valid security group ID."
  }
}
