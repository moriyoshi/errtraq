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
