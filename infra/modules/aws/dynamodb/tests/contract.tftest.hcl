mock_provider "aws" {}
run "store_indexes_and_permissions" {
  command = apply
  variables {
    name = "example"

    tags    = {}
    purpose = "store"
  }
  assert {
    condition     = jsonencode(jsondecode(output.policies.read.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"], Resource = [aws_dynamodb_table.this.arn, "${aws_dynamodb_table.this.arn}/index/*"] }] }) && jsonencode(jsondecode(output.policies.write.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"], Resource = [aws_dynamodb_table.this.arn] }] }) && jsonencode(jsondecode(output.policies.delete.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:DeleteItem"], Resource = [aws_dynamodb_table.this.arn] }] })
    error_message = "Every DynamoDB policy must have exactly the intended actions and resources."
  }
  assert {
    condition     = toset([for gsi in aws_dynamodb_table.this.global_secondary_index : gsi.name]) == toset([for index in range(1, 9) : "gsi${index}"]) && aws_dynamodb_table.this.hash_key == "PK" && aws_dynamodb_table.this.range_key == "SK" && aws_dynamodb_table.this.billing_mode == "PAY_PER_REQUEST" && aws_dynamodb_table.this.point_in_time_recovery[0].enabled && aws_dynamodb_table.this.server_side_encryption[0].enabled && aws_dynamodb_table.this.ttl[0].enabled && aws_dynamodb_table.this.ttl[0].attribute_name == "expiresAt" && alltrue([for gsi in aws_dynamodb_table.this.global_secondary_index : gsi.projection_type == "ALL" && toset([for key in gsi.key_schema : "${key.key_type}:${key.attribute_name}"]) == toset(["HASH:GSI${trimprefix(gsi.name, "gsi")}PK", "RANGE:GSI${trimprefix(gsi.name, "gsi")}SK"])])
    error_message = "DynamoDB recovery, encryption, TTL and exact GSI key schemas / projections must be enabled."
  }
  assert {
    condition     = alltrue(flatten([for resources in values(output.policies) : [for policy in values(resources) : length(policy) <= 1024]]))
    error_message = "Current per-resource policies must fit the 1024-character sizing budget."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["read", "write", "delete"]) && alltrue([for policy in values(output.policies) : toset(keys(policy)) == toset(["primary"]) && can(jsondecode(policy.primary))])
    error_message = "Policy output shape and encoded-document leaves must match the descriptor."
  }
  assert {
    condition     = length(aws_dynamodb_table.this.global_secondary_index) == 8 && aws_dynamodb_table.this.deletion_protection_enabled
    error_message = "The store must have its eight indexes and deletion protection."
  }
  assert {
    condition     = toset(jsondecode(output.policies.delete.primary).Statement[0].Action) == toset(["dynamodb:DeleteItem"])
    error_message = "Delete capability must not allow batch writes or puts."
  }
  assert {
    condition     = alltrue([for gsi in aws_dynamodb_table.this.global_secondary_index : length(gsi.key_schema) == 2 && toset([for key in gsi.key_schema : key.key_type]) == toset(["HASH", "RANGE"])])
    error_message = "Every GSI must use key_schema for its hash and range keys."
  }
  assert {
    condition     = !contains(jsondecode(output.policies.read.primary).Statement[0].Action, "dynamodb:Scan") && contains(jsondecode(output.policies.write.primary).Statement[0].Action, "dynamodb:ConditionCheckItem")
    error_message = "Queries must not scan, and transactional conditions need IAM permission."
  }
}
run "kv_without_indexes" {
  command = apply
  variables {
    name = "example"

    tags       = {}
    purpose    = "kv"
    protection = "disposable"
  }
  assert {
    condition     = jsonencode(jsondecode(output.policies.write.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"], Resource = [aws_dynamodb_table.this.arn] }] })
    error_message = "KV writes require only PutItem, UpdateItem and the strongly consistent GetItem used by increment."
  }
  assert {
    condition     = length(aws_dynamodb_table.this.global_secondary_index) == 0 && !aws_dynamodb_table.this.deletion_protection_enabled
    error_message = "The KV table does not need store indexes."
  }
}
