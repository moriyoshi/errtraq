mock_provider "aws" {}
run "policies_and_lifecycle" {
  command = apply
  variables {
    name           = "example"
    region         = "us-east-1"
    tags           = {}
    staging_prefix = "archive-staging/"
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
