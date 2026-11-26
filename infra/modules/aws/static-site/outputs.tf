output "domain_name" {
  value       = aws_cloudfront_distribution.site.domain_name
  description = "errtraq-type=string; errtraq-keys=; CloudFront domain name; the web UI and the same-origin API are served at https://<domain_name>/"
}
output "distribution_id" {
  value       = aws_cloudfront_distribution.site.id
  description = "errtraq-type=string; errtraq-keys=; CloudFront distribution ID, for cache invalidation"
}
output "bucket_name" {
  value       = aws_s3_bucket.site.id
  description = "errtraq-type=string; errtraq-keys=; Private S3 bucket that holds the UI assets"
}
