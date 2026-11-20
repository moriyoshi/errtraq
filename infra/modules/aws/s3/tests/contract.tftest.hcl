mock_provider "aws" {}
run "policies_and_lifecycle" {
  command = apply
  variables {
    name = "example"

    tags           = {}
    staging_prefix = "archive-staging/"
  }
  assert {
    condition     = alltrue(flatten([for resources in values(output.policies) : [for policy in values(resources) : length(policy) <= 1024]]))
    error_message = "Current per-resource policies must fit the 1024-character sizing budget."
  }
  assert {
    condition     = alltrue([for purpose in ["primary", "staging"] : jsondecode(output.policies.read[purpose]).Statement[1].Action == ["s3:ListBucket"] && length(jsondecode(output.policies.read[purpose]).Statement[1].Condition.StringLike["s3:prefix"]) > 0])
    error_message = "Read policies must provide prefix-restricted listing for missing keys."
  }
  assert {
    condition     = !aws_s3_bucket.this.force_destroy && aws_s3_bucket_ownership_controls.this.rule[0].object_ownership == "BucketOwnerEnforced" && jsondecode(aws_s3_bucket_policy.tls.policy).Statement[0].Condition.Bool["aws:SecureTransport"] == "false" && one([for rule in aws_s3_bucket_lifecycle_configuration.this.rule : rule.abort_incomplete_multipart_upload[0].days_after_initiation if rule.id == "abort-incomplete-uploads"]) == 7
    error_message = "Production bucket must deny insecure transport, enforce ownership and abort incomplete uploads."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["read", "write", "delete", "list"]) && alltrue([for policies in values(output.policies) : toset(keys(policies)) == toset(["primary", "staging"]) && alltrue([for policy in values(policies) : can(jsondecode(policy))])])
    error_message = "Policy output shape and encoded-document leaves must match the descriptor."
  }
  assert {
    condition     = jsondecode(output.policies.write.staging).Statement[0].Resource[0] == "${aws_s3_bucket.this.arn}/archive-staging/*"
    error_message = "Staging writes must be limited to the staging prefix."
  }
  assert {
    condition     = !contains(jsondecode(output.policies.write.primary).Statement[0].Resource, "${aws_s3_bucket.this.arn}/archive-staging/*")
    error_message = "Primary writes must not grant staging access."
  }
  assert {
    condition     = jsondecode(output.policies.list.staging).Statement[0].Condition.StringLike["s3:prefix"][0] == "archive-staging/*"
    error_message = "Staging list permission must be prefix limited."
  }
  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Disabled"
    error_message = "Versioning must remain disabled for erasure."
  }
}

run "disposable_bucket" {
  command = apply
  variables {
    name           = "example"
    tags           = {}
    staging_prefix = "archive-staging/"
    protection     = "disposable"
  }
  assert {
    condition     = aws_s3_bucket.this.force_destroy
    error_message = "Disposable buckets must allow teardown."
  }
}
