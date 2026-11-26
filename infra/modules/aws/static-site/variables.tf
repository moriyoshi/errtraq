variable "name" {
  type        = string
  description = "Stack name used as the resource name prefix."
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
variable "api_origin_url" {
  type        = string
  description = "The API function URL (an https URL of the form https://<id>.lambda-url.<region>.on.aws/). Its URL authorization must be NONE: the API authenticates the Bearer token itself, and CloudFront origin access control would replace that Authorization header with its own signature."
  validation {
    condition     = can(regex("^https://[a-z0-9.-]+/?$", var.api_origin_url))
    error_message = "api_origin_url must be an https function URL without a path."
  }
}
variable "assets_directory" {
  type        = string
  description = "Build output directory of the UI (written by errtraq build): manifest.json lists the assets, and the files are under site/. It is a build input; the source tree is never read."
  validation {
    condition     = can(jsondecode(file("${var.assets_directory}/manifest.json")).assets)
    error_message = "assets_directory must hold the manifest.json that errtraq build writes."
  }
  validation {
    condition     = can(jsondecode(file("${var.assets_directory}/manifest.json")).version == 1 && contains([for asset in jsondecode(file("${var.assets_directory}/manifest.json")).assets : asset.path], "index.html"))
    error_message = "The UI manifest must be version 1 and list index.html."
  }
}
variable "price_class" {
  type        = string
  description = "CloudFront price class."
  default     = "PriceClass_100"
  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}
variable "aliases" {
  type        = list(string)
  description = "Custom domain names for the distribution (exact host names; the operator creates the DNS records). Requires certificate_arn. Empty keeps the default CloudFront domain and certificate."
  default     = []
  validation {
    condition     = length(var.aliases) <= 10 && length(distinct(var.aliases)) == length(var.aliases) && alltrue([for alias in var.aliases : can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])$", alias))])
    error_message = "aliases must be at most 10 distinct lower-case host names."
  }
}
variable "certificate_arn" {
  type        = string
  description = "An existing ACM certificate covering every alias. CloudFront reads certificates from us-east-1 only, so the ARN must be in that region. Never created here."
  default     = null
  validation {
    condition     = var.certificate_arn == null ? true : can(regex("^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]{36}$", var.certificate_arn))
    error_message = "certificate_arn must be an ACM certificate ARN in us-east-1."
  }
  validation {
    condition     = (length(var.aliases) == 0) == (var.certificate_arn == null)
    error_message = "aliases and certificate_arn go together: a custom domain needs a certificate, and a certificate is only used for aliases."
  }
}
variable "waf_acl_arn" {
  type        = string
  description = "An existing CLOUDFRONT-scope WAFv2 web ACL (us-east-1) to attach to the distribution. Never created here."
  default     = null
  validation {
    condition     = var.waf_acl_arn == null ? true : can(regex("^arn:aws:wafv2:us-east-1:[0-9]{12}:global/webacl/[A-Za-z0-9_-]{1,128}/[0-9a-f-]{36}$", var.waf_acl_arn))
    error_message = "waf_acl_arn must be a CLOUDFRONT-scope WAFv2 web ACL ARN (arn:aws:wafv2:us-east-1:<account>:global/webacl/<name>/<id>)."
  }
}
