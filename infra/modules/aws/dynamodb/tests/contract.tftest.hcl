mock_provider "aws" {}
run "store_indexes_and_permissions" {
  command = apply
  variables {
    name    = "example"
    region  = "us-east-1"
    tags    = {}
    purpose = "store"
  }
  assert {
    condition     = length(aws_dynamodb_table.this.global_secondary_index) == 8 && aws_dynamodb_table.this.deletion_protection_enabled
    error_message = "The store must have its eight indexes and deletion protection."
  }
  assert {
    condition     = !contains(jsondecode(output.policies.read.primary).Statement[0].Action, "dynamodb:Scan") && contains(jsondecode(output.policies.write.primary).Statement[0].Action, "dynamodb:ConditionCheckItem")
    error_message = "Queries must not scan, and transactional conditions need IAM permission."
  }
}
run "kv_without_indexes" {
  command = apply
  variables {
    name    = "example"
    region  = "us-east-1"
    tags    = {}
    purpose = "kv"
  }
  assert {
    condition     = length(aws_dynamodb_table.this.global_secondary_index) == 0
    error_message = "The KV table does not need store indexes."
  }
}
