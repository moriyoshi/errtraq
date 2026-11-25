mock_provider "aws" {}
run "policies_and_lifecycle" {
  command = apply
  variables {
    name = "example"

    tags = {}
  }
  assert {
    condition = alltrue([for purpose, prefixes in { primary = ["envelopes/", "payloads/", "artifacts/", "archive-overflow/"] } :
      jsonencode(jsondecode(output.policies.read[purpose])) == jsonencode({ Version = "2012-10-17", Statement = [
        { Effect = "Allow", Action = ["s3:GetObject"], Resource = [for prefix in prefixes : "${aws_s3_bucket.this.arn}/${prefix}*"] },
        { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.this.arn, Condition = { StringLike = { "s3:prefix" = [for prefix in prefixes : "${prefix}*"] } } }
      ] }) &&
      jsonencode(jsondecode(output.policies.write[purpose])) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["s3:PutObject", "s3:AbortMultipartUpload"], Resource = [for prefix in prefixes : "${aws_s3_bucket.this.arn}/${prefix}*"] }] }) &&
      jsonencode(jsondecode(output.policies.delete[purpose])) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["s3:DeleteObject"], Resource = [for prefix in prefixes : "${aws_s3_bucket.this.arn}/${prefix}*"] }] }) &&
      jsonencode(jsondecode(output.policies.list[purpose])) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.this.arn, Condition = { StringLike = { "s3:prefix" = [for prefix in prefixes : "${prefix}*"] } } }] })
    ])
    error_message = "Every S3 policy must match its capability and prefix-scoped resources exactly."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.this.block_public_acls && aws_s3_bucket_public_access_block.this.block_public_policy && aws_s3_bucket_public_access_block.this.ignore_public_acls && aws_s3_bucket_public_access_block.this.restrict_public_buckets && one(one(aws_s3_bucket_server_side_encryption_configuration.this.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256" && jsonencode(jsondecode(aws_s3_bucket_policy.tls.policy)) == jsonencode({ Version = "2012-10-17", Statement = [{ Sid = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.this.arn, "${aws_s3_bucket.this.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] }) && one([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : rule.expiration[0].days if rule.id == "abandoned-envelopes"]) == 14
    error_message = "Public access, encryption, TLS and expiry rules must remain secure."
  }
  assert {
    condition     = alltrue(flatten([for resources in values(output.policies) : [for policy in values(resources) : length(policy) <= 1024]]))
    error_message = "Current per-resource policies must fit the 1024-character sizing budget."
  }
  assert {
    condition     = alltrue([for purpose in ["primary"] : jsondecode(output.policies.read[purpose]).Statement[1].Action == ["s3:ListBucket"] && length(jsondecode(output.policies.read[purpose]).Statement[1].Condition.StringLike["s3:prefix"]) > 0])
    error_message = "Read policies must provide prefix-restricted listing for missing keys."
  }
  assert {
    condition     = !aws_s3_bucket.this.force_destroy && aws_s3_bucket_ownership_controls.this.rule[0].object_ownership == "BucketOwnerEnforced" && jsondecode(aws_s3_bucket_policy.tls.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false" && one([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : rule.abort_incomplete_multipart_upload[0].days_after_initiation if rule.id == "abort-incomplete-uploads"]) == 7
    error_message = "Production bucket must deny insecure transport, enforce ownership and abort incomplete uploads."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["read", "write", "delete", "list"]) && alltrue([for policies in values(output.policies) : toset(keys(policies)) == toset(["primary"]) && alltrue([for policy in values(policies) : can(jsondecode(policy))])])
    error_message = "Policy output shape and encoded-document leaves must match the descriptor."
  }
  assert {
    condition     = toset(jsondecode(output.policies.write.primary).Statement[0].Resource) == toset(["${aws_s3_bucket.this.arn}/envelopes/*", "${aws_s3_bucket.this.arn}/payloads/*", "${aws_s3_bucket.this.arn}/artifacts/*", "${aws_s3_bucket.this.arn}/archive-overflow/*"]) && !anytrue([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : strcontains(rule.id, "staging")])
    error_message = "The archive batch manifests are covered by the primary grants, and no staging prefix or rule remains."
  }
  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Disabled"
    error_message = "Versioning must remain disabled for erasure."
  }
}

run "claim_and_overflow_lifecycle" {
  command = apply
  variables {
    name = "example"
    tags = {}
  }
  assert {
    condition     = one([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : rule.expiration[0].days if rule.id == "expired-record-claims"]) == 30 && one([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : one(rule.filter).prefix if rule.id == "expired-record-claims"]) == "payloads/records/"
    error_message = "Record claim checks must expire after 30 days by default under payloads/records/."
  }
  assert {
    condition     = one([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : rule.expiration[0].days if rule.id == "abandoned-artifact-chunks"]) == 7 && one([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : one(rule.filter).prefix if rule.id == "abandoned-artifact-chunks"]) == "artifacts/chunks/"
    error_message = "Unassembled artifact chunks must expire after 7 days under artifacts/chunks/."
  }
  assert {
    condition = length([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : rule if startswith(rule.id, "orphaned-overflow-payloads-")]) == 10 && alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.this.rule : rule.expiration[0].days == 37 && length(one(rule.filter).prefix) == 10 && !startswith("payloads/records/", one(rule.filter).prefix) && !startswith(one(rule.filter).prefix, "payloads/records/")
      if startswith(rule.id, "orphaned-overflow-payloads-")
    ])
    error_message = "Overflow orphans must expire after retention plus margin, one rule per project-ID digit, none overlapping payloads/records/."
  }
  assert {
    condition     = toset([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : one(rule.filter).prefix if startswith(rule.id, "orphaned-overflow-payloads-")]) == toset([for d in range(10) : "payloads/${d}"])
    error_message = "Overflow rules must cover exactly the decimal project-ID prefixes."
  }
}
run "custom_overflow_age" {
  command = apply
  variables {
    name                        = "example"
    tags                        = {}
    max_event_retention_days    = 90
    overflow_orphan_margin_days = 10
    record_claim_retention_days = 20
  }
  assert {
    condition     = alltrue([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : rule.expiration[0].days == 100 if startswith(rule.id, "orphaned-overflow-payloads-")]) && one([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : rule.expiration[0].days if rule.id == "expired-record-claims"]) == 20
    error_message = "Configured ages must reach the lifecycle rules."
  }
}
run "claim_age_below_sqs_retention" {
  command = plan
  variables {
    name                        = "example"
    tags                        = {}
    record_claim_retention_days = 14
  }
  expect_failures = [var.record_claim_retention_days]
}
run "disposable_bucket" {
  command = apply
  variables {
    name       = "example"
    tags       = {}
    protection = "disposable"
  }
  assert {
    condition     = aws_s3_bucket.this.force_destroy
    error_message = "Disposable buckets must allow teardown."
  }
}
