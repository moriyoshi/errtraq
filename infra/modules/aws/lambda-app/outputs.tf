output "ingest_url" {
  value       = local.role_urls.ingest
  description = "errtraq-type=string; errtraq-keys=; Ingest function URL or an empty string when unexposed"
}
output "api_url" {
  value       = local.role_urls.api
  description = "errtraq-type=string; errtraq-keys=; API function URL or an empty string when unexposed"
}
output "bootstrap_function_name" {
  value       = length(local.bootstrap_functions) > 0 ? aws_lambda_function.function[keys(local.bootstrap_functions)[0]].function_name : ""
  description = "errtraq-type=string; errtraq-keys=; Bootstrap function name for lambda:InvokeFunction, or an empty string when the role is not deployed"
}
output "bootstrap_function_arn" {
  value       = length(local.bootstrap_functions) > 0 ? aws_lambda_function.function[keys(local.bootstrap_functions)[0]].arn : ""
  description = "errtraq-type=string; errtraq-keys=; Bootstrap function ARN, or an empty string when the role is not deployed"
}
output "image_repository_url" {
  value       = length(aws_ecr_repository.image) > 0 ? aws_ecr_repository.image[0].repository_url : ""
  description = "errtraq-type=string; errtraq-keys=; ECR repository URL for the container-image functions, or an empty string when none exist"
}
output "ui_domain_name" {
  value       = length(module.static_site) > 0 ? module.static_site[0].domain_name : ""
  description = "errtraq-type=string; errtraq-keys=; CloudFront domain name of the web UI (https://<domain>/ serves the UI and the same-origin API), or an empty string without ui"
}
output "ui_distribution_id" {
  value       = length(module.static_site) > 0 ? module.static_site[0].distribution_id : ""
  description = "errtraq-type=string; errtraq-keys=; CloudFront distribution ID of the web UI, or an empty string without ui"
}
output "ui_bucket_name" {
  value       = length(module.static_site) > 0 ? module.static_site[0].bucket_name : ""
  description = "errtraq-type=string; errtraq-keys=; S3 bucket that holds the web UI assets, or an empty string without ui"
}
