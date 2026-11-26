locals {
  manifest = jsondecode(file("${var.assets_directory}/manifest.json"))
  assets   = { for asset in local.manifest.assets : asset.path => asset }
  api_host = regex("^https://([^/]+)/?$", var.api_origin_url)[0]
  # Paths the SPA rewrite leaves alone: files at the root and everything under a top-level
  # directory of the build (hashed assets). Any other path is a client-side route when the
  # viewer accepts text/html, and passes through (a 404) otherwise.
  root_files = sort([for path in keys(local.assets) : "/${path}" if length(split("/", path)) == 1])
  prefixes   = sort(distinct([for path in keys(local.assets) : "/${split("/", path)[0]}/" if length(split("/", path)) > 1]))
}
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}
# The Lambda function URL rejects a request whose Host is not its own, so the viewer's Host is
# not forwarded; every other viewer header (including Authorization) and the query string are.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_s3_bucket" "site" {
  bucket_prefix = "${substr(lower(var.name), 0, 30)}-ui-"
  tags          = var.tags
}
resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule { object_ownership = "BucketOwnerEnforced" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${substr(var.name, 0, 40)}-ui"
  description                       = "${var.name} web UI bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
# Only this distribution reads the bucket. Listing lets a missing key answer 404 instead of 403.
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "AllowCloudFrontRead"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
      },
      {
        Sid       = "AllowCloudFrontList"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:ListBucket"
        Resource  = aws_s3_bucket.site.arn
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.site]
}

# One object per manifest entry: type and cache rules come from the build, and a changed hash
# replaces the object. A file that leaves the manifest leaves the bucket.
resource "aws_s3_object" "asset" {
  for_each      = local.assets
  bucket        = aws_s3_bucket.site.id
  key           = each.key
  source        = "${var.assets_directory}/site/${each.key}"
  source_hash   = each.value.contentHash
  content_type  = each.value.contentType
  cache_control = each.value.cacheControl
  tags          = var.tags
}

# SPA fallback on the default behavior only. A distribution-wide custom error response for 403 and
# 404 would also rewrite the API's own JSON errors into index.html, so the rewrite is a viewer
# request function that the /api/0/* behavior never sees. It rewrites only requests that accept
# text/html (the standalone server's rule), so a missing image or script is a 404, not index.html.
# The handler is spa-rewrite.js, run under Node by the repository's tests.
resource "aws_cloudfront_function" "spa" {
  name    = "${substr(var.name, 0, 40)}-ui-spa"
  runtime = "cloudfront-js-2.0"
  comment = "Rewrites navigations to client-side routes to /index.html"
  publish = true
  code    = <<-EOT
    var ROOT_FILES = ${jsonencode(local.root_files)};
    var PREFIXES = ${jsonencode(local.prefixes)};
    ${file("${path.module}/spa-rewrite.js")}
  EOT
}
resource "aws_cloudfront_response_headers_policy" "site" {
  name    = "${substr(var.name, 0, 40)}-ui-security"
  comment = "Security headers for the web UI"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      override                   = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    # The page's own <meta> CSP cannot carry frame-ancestors.
    content_security_policy {
      content_security_policy = "frame-ancestors 'none'"
      override                = true
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  comment             = "${var.name} web UI and same-origin API"
  default_root_object = "index.html"
  price_class         = var.price_class
  tags                = var.tags
  aliases             = var.aliases
  web_acl_id          = var.waf_acl_arn

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }
  # The API function URL keeps authorization NONE: origin access control would sign the origin
  # request with SigV4 in the Authorization header, replacing the user's Bearer token.
  origin {
    origin_id   = "api"
    domain_name = local.api_host
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  # Ingest (/api/<projectId>/envelope/ ...) stays on its own function URL, the DSN host, and is
  # not routed here. Project ID 0 is rejected (isProjectId in core), so /api/0/* cannot collide with
  # an ingest path. The API builds Link and permalink URLs from its configured public API URL
  # (ERRTRAQ_PUBLIC_API_URL), not from the request, whose host here is the function URL.
  ordered_cache_behavior {
    path_pattern             = "/api/0/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }
  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa.arn
    }
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  # Aliases need the operator's certificate (SNI only: no dedicated IP charge); without them the
  # default CloudFront certificate serves the *.cloudfront.net name.
  viewer_certificate {
    cloudfront_default_certificate = var.certificate_arn == null ? true : null
    acm_certificate_arn            = var.certificate_arn
    ssl_support_method             = var.certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.certificate_arn == null ? null : "TLSv1.2_2021"
  }
}
