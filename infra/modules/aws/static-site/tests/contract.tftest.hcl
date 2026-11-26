mock_provider "aws" {
  mock_data "aws_cloudfront_cache_policy" {
    defaults = { id = "00000000-0000-0000-0000-000000000001" }
  }
  mock_data "aws_cloudfront_origin_request_policy" {
    defaults = { id = "00000000-0000-0000-0000-000000000002" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::example-ui-123", id = "example-ui-123", bucket_regional_domain_name = "example-ui-123.s3.us-east-1.amazonaws.com" }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = { arn = "arn:aws:cloudfront::000000000000:distribution/EXAMPLE", id = "EXAMPLE", domain_name = "d111111abcdef8.cloudfront.net" }
  }
  mock_resource "aws_cloudfront_function" {
    defaults = { arn = "arn:aws:cloudfront::000000000000:function/example-ui-spa" }
  }
}
variables {
  name             = "example"
  tags             = { app = "errtraq" }
  api_origin_url   = "https://abcdefghijklmnop.lambda-url.us-east-1.on.aws/"
  assets_directory = "tests/ui"
}
run "private_bucket_served_only_through_the_distribution" {
  command = apply
  assert {
    condition     = aws_s3_bucket_public_access_block.site.block_public_acls && aws_s3_bucket_public_access_block.site.block_public_policy && aws_s3_bucket_public_access_block.site.ignore_public_acls && aws_s3_bucket_public_access_block.site.restrict_public_buckets
    error_message = "The UI bucket must block all public access."
  }
  assert {
    condition     = one(aws_s3_bucket_ownership_controls.site.rule).object_ownership == "BucketOwnerEnforced" && one(one(aws_s3_bucket_server_side_encryption_configuration.site.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "The UI bucket must enforce ownership and use SSE-S3."
  }
  assert {
    condition     = aws_cloudfront_origin_access_control.site.origin_access_control_origin_type == "s3" && aws_cloudfront_origin_access_control.site.signing_behavior == "always" && aws_cloudfront_origin_access_control.site.signing_protocol == "sigv4" && one([for origin in aws_cloudfront_distribution.site.origin : origin if origin.origin_id == "site"]).origin_access_control_id == aws_cloudfront_origin_access_control.site.id
    error_message = "The bucket origin must use origin access control."
  }
  assert {
    condition = (
      length([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : s if s.Effect == "Allow"]) == 2 &&
      alltrue([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : s.Effect == "Deny" || (s.Principal == { Service = "cloudfront.amazonaws.com" } && s.Condition == { StringEquals = { "AWS:SourceArn" = "arn:aws:cloudfront::000000000000:distribution/EXAMPLE" } })]) &&
      toset(flatten([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : s.Action if s.Effect == "Allow"])) == toset(["s3:GetObject", "s3:ListBucket"])
    )
    error_message = "Only the distribution may read the bucket, with GetObject and ListBucket."
  }
  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.site.policy).Statement : s if s.Effect == "Deny" && s.Condition == { Bool = { "aws:SecureTransport" = "false" } }]) == 1
    error_message = "The bucket must refuse non-TLS requests."
  }
}
run "assets_come_from_the_build_manifest" {
  command = apply
  assert {
    condition     = toset(keys(aws_s3_object.asset)) == toset(["index.html", "favicon.svg", "assets/index-abc123.js", "assets/index-abc123.css"])
    error_message = "One object per manifest entry."
  }
  assert {
    condition     = aws_s3_object.asset["assets/index-abc123.js"].cache_control == "public, max-age=31536000, immutable" && aws_s3_object.asset["assets/index-abc123.js"].content_type == "text/javascript; charset=utf-8" && aws_s3_object.asset["index.html"].cache_control == "no-cache" && aws_s3_object.asset["index.html"].content_type == "text/html; charset=utf-8" && aws_s3_object.asset["index.html"].source == "tests/ui/site/index.html" && aws_s3_object.asset["index.html"].source_hash == jsondecode(file("tests/ui/manifest.json")).assets[3].contentHash
    error_message = "Content type, cache control, source and hash come from the manifest."
  }
}
run "api_behavior_keeps_the_bearer_token_and_never_caches" {
  command = apply
  assert {
    condition     = length(aws_cloudfront_distribution.site.ordered_cache_behavior) == 1 && one(aws_cloudfront_distribution.site.ordered_cache_behavior).path_pattern == "/api/0/*" && one(aws_cloudfront_distribution.site.ordered_cache_behavior).target_origin_id == "api"
    error_message = "One behavior routes /api/0/* to the API origin."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.site.ordered_cache_behavior).viewer_protocol_policy == "https-only" && toset(one(aws_cloudfront_distribution.site.ordered_cache_behavior).allowed_methods) == toset(["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"])
    error_message = "The API behavior must be HTTPS only and allow every method."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.site.ordered_cache_behavior).cache_policy_id == data.aws_cloudfront_cache_policy.caching_disabled.id && one(aws_cloudfront_distribution.site.ordered_cache_behavior).origin_request_policy_id == data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id && data.aws_cloudfront_cache_policy.caching_disabled.name == "Managed-CachingDisabled" && data.aws_cloudfront_origin_request_policy.all_viewer_except_host.name == "Managed-AllViewerExceptHostHeader"
    error_message = "The API behavior must use the managed CachingDisabled and AllViewerExceptHostHeader policies."
  }
  assert {
    condition     = !contains([for f in one(aws_cloudfront_distribution.site.ordered_cache_behavior).function_association : f.function_arn], aws_cloudfront_function.spa.arn)
    error_message = "The SPA rewrite must not run on the API behavior."
  }
  assert {
    condition     = one([for origin in aws_cloudfront_distribution.site.origin : origin if origin.origin_id == "api"]).domain_name == "abcdefghijklmnop.lambda-url.us-east-1.on.aws" && one([for origin in aws_cloudfront_distribution.site.origin : origin if origin.origin_id == "api"]).origin_access_control_id != aws_cloudfront_origin_access_control.site.id && one(one([for origin in aws_cloudfront_distribution.site.origin : origin if origin.origin_id == "api"]).custom_origin_config).origin_protocol_policy == "https-only"
    error_message = "The API origin is the function URL host over HTTPS and must not use origin access control (it would replace the Authorization header)."
  }
}
run "spa_fallback_is_a_viewer_function_not_error_responses" {
  command = apply
  assert {
    condition     = length(aws_cloudfront_distribution.site.custom_error_response) == 0
    error_message = "Custom error responses would rewrite the API's 403 and 404 JSON into index.html."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.site.default_cache_behavior).target_origin_id == "site" && one(aws_cloudfront_distribution.site.default_cache_behavior).viewer_protocol_policy == "redirect-to-https" && toset(one(aws_cloudfront_distribution.site.default_cache_behavior).allowed_methods) == toset(["GET", "HEAD"]) && one(one(aws_cloudfront_distribution.site.default_cache_behavior).function_association).event_type == "viewer-request" && one(one(aws_cloudfront_distribution.site.default_cache_behavior).function_association).function_arn == aws_cloudfront_function.spa.arn && aws_cloudfront_distribution.site.default_root_object == "index.html"
    error_message = "The default behavior serves the bucket read-only with the SPA rewrite on viewer request."
  }
  assert {
    condition     = strcontains(aws_cloudfront_function.spa.code, "[\"/favicon.svg\",\"/index.html\"]") && strcontains(aws_cloudfront_function.spa.code, "[\"/assets/\"]") && strcontains(aws_cloudfront_function.spa.code, "request.uri = \"/index.html\"") && strcontains(aws_cloudfront_function.spa.code, "indexOf(\"text/html\")") && strcontains(aws_cloudfront_function.spa.code, "request.headers.accept") && aws_cloudfront_function.spa.runtime == "cloudfront-js-2.0" && aws_cloudfront_function.spa.publish
    error_message = "The function must keep the build's root files and directories and rewrite only requests that accept text/html."
  }
}
run "security_headers_on_the_default_behavior" {
  command = apply
  assert {
    condition     = one(aws_cloudfront_response_headers_policy.site.security_headers_config).strict_transport_security[0].access_control_max_age_sec == 63072000 && one(aws_cloudfront_response_headers_policy.site.security_headers_config).strict_transport_security[0].override && one(aws_cloudfront_response_headers_policy.site.security_headers_config).content_type_options[0].override && one(aws_cloudfront_response_headers_policy.site.security_headers_config).referrer_policy[0].referrer_policy == "no-referrer" && one(aws_cloudfront_response_headers_policy.site.security_headers_config).content_security_policy[0].content_security_policy == "frame-ancestors 'none'"
    error_message = "HSTS, nosniff, no-referrer and frame-ancestors 'none' are required."
  }
  assert {
    condition     = one(aws_cloudfront_distribution.site.default_cache_behavior).response_headers_policy_id == aws_cloudfront_response_headers_policy.site.id && one(aws_cloudfront_distribution.site.ordered_cache_behavior).response_headers_policy_id != aws_cloudfront_response_headers_policy.site.id
    error_message = "The headers policy applies to the default behavior only."
  }
}
run "output_values" {
  command = apply
  assert {
    condition     = output.domain_name == "d111111abcdef8.cloudfront.net" && output.distribution_id == "EXAMPLE" && output.bucket_name == "example-ui-123"
    error_message = "Outputs must name the distribution domain, its ID and the bucket."
  }
}
run "rejects_non_https_or_pathful_api_origin" {
  command = plan
  variables {
    api_origin_url = "http://abcdefghijklmnop.lambda-url.us-east-1.on.aws/"
  }
  expect_failures = [var.api_origin_url]
}
run "rejects_a_directory_without_a_manifest" {
  command = plan
  variables {
    assets_directory = "tests"
  }
  expect_failures = [var.assets_directory]
}
run "default_domain_uses_the_cloudfront_certificate" {
  command = apply
  assert {
    condition     = length(aws_cloudfront_distribution.site.aliases) == 0 && one(aws_cloudfront_distribution.site.viewer_certificate).cloudfront_default_certificate == true && one(aws_cloudfront_distribution.site.viewer_certificate).acm_certificate_arn == null && aws_cloudfront_distribution.site.web_acl_id == null
    error_message = "Without aliases the default CloudFront certificate is used and no web ACL is attached."
  }
}
run "custom_domain_uses_the_operators_certificate_and_web_acl" {
  command = apply
  variables {
    aliases         = ["errtraq.example.com", "ui.example.com"]
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
    waf_acl_arn     = "arn:aws:wafv2:us-east-1:123456789012:global/webacl/errtraq/11111111-2222-3333-4444-555555555555"
  }
  assert {
    condition     = toset(aws_cloudfront_distribution.site.aliases) == toset(["errtraq.example.com", "ui.example.com"]) && one(aws_cloudfront_distribution.site.viewer_certificate).acm_certificate_arn == "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555" && one(aws_cloudfront_distribution.site.viewer_certificate).ssl_support_method == "sni-only" && one(aws_cloudfront_distribution.site.viewer_certificate).minimum_protocol_version == "TLSv1.2_2021" && one(aws_cloudfront_distribution.site.viewer_certificate).cloudfront_default_certificate != true
    error_message = "Aliases need the operator's certificate over SNI with TLS 1.2 or newer."
  }
  assert {
    condition     = aws_cloudfront_distribution.site.web_acl_id == "arn:aws:wafv2:us-east-1:123456789012:global/webacl/errtraq/11111111-2222-3333-4444-555555555555"
    error_message = "The web ACL is attached to the distribution."
  }
}
run "rejects_aliases_without_a_certificate" {
  command = plan
  variables {
    aliases = ["errtraq.example.com"]
  }
  expect_failures = [var.certificate_arn]
}
run "rejects_a_certificate_outside_us_east_1" {
  command = plan
  variables {
    aliases         = ["errtraq.example.com"]
    certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
  }
  expect_failures = [var.certificate_arn]
}
run "rejects_a_certificate_without_aliases" {
  command = plan
  variables {
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
  }
  expect_failures = [var.certificate_arn]
}
run "rejects_bad_aliases_and_a_regional_web_acl" {
  command = plan
  variables {
    aliases         = ["Errtraq.Example.com", "*.example.com"]
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
    waf_acl_arn     = "arn:aws:wafv2:eu-west-1:123456789012:regional/webacl/errtraq/11111111-2222-3333-4444-555555555555"
  }
  expect_failures = [var.aliases, var.waf_acl_arn]
}
run "rejects_unknown_price_class" {
  command = plan
  variables {
    price_class = "PriceClass_Mars"
  }
  expect_failures = [var.price_class]
}
