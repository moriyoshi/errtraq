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
