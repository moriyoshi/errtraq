mock_provider "aws" {}
run "store_indexes_and_permissions" {
  state_key = "store"
  command   = apply
  variables {
    name    = "example"
    tags    = {}
    purpose = "store"
  }
  assert {
    condition     = aws_dynamodb_table.this.name == "example-store-v2" && aws_dynamodb_table.this.hash_key == "PK" && aws_dynamodb_table.this.range_key == "SK" && aws_dynamodb_table.this.billing_mode == "PAY_PER_REQUEST" && aws_dynamodb_table.this.point_in_time_recovery[0].enabled && aws_dynamodb_table.this.server_side_encryption[0].enabled && aws_dynamodb_table.this.ttl[0].enabled && aws_dynamodb_table.this.ttl[0].attribute_name == "ttlEpoch" && aws_dynamodb_table.this.deletion_protection_enabled
    error_message = "Store key, recovery, encryption, numeric TTL and production protection must match."
  }
  assert {
    condition     = jsondecode(file("${path.module}/indexes.json")) == { "event-project-time" = { hash = "GSI1PK", range = "GSI1SK" }, "event-issue-time" = { hash = "GSI2PK", range = "GSI2SK" }, "issue-id" = { hash = "GSI3PK", range = "GSI3SK" }, "issue-last" = { hash = "GSI4PK", range = "GSI4SK" }, "issue-first" = { hash = "GSI5PK", range = "GSI5SK" }, "issue-count" = { hash = "GSI6PK", range = "GSI6SK" }, "entity-list" = { hash = "GSI7PK", range = "GSI7SK" }, "erasure-all" = { hash = "GSI8PK", range = "GSI8SK" }, "erasure-project" = { hash = "GSI9PK", range = "GSI9SK" }, "erasure-state" = { hash = "GSI10PK", range = "GSI10SK" }, "erasure-project-state" = { hash = "GSI11PK", range = "GSI11SK" } }
    error_message = "The store index-to-key mapping must match the approved layout exactly."
  }
  assert {
    condition     = length(aws_dynamodb_table.this.global_secondary_index) == 11 && alltrue([for gsi in aws_dynamodb_table.this.global_secondary_index : contains(keys(jsondecode(file("${path.module}/indexes.json"))), gsi.name) && gsi.projection_type == "KEYS_ONLY" && toset([for key in gsi.key_schema : "${key.key_type}:${key.attribute_name}"]) == toset(["HASH:${jsondecode(file("${path.module}/indexes.json"))[gsi.name].hash}", "RANGE:${jsondecode(file("${path.module}/indexes.json"))[gsi.name].range}"])])
    error_message = "All eleven sparse indexes must use their exact string keys and keys-only projection."
  }
  assert {
    condition     = toset([for a in aws_dynamodb_table.this.attribute : "${a.name}:${a.type}"]) == toset(concat(["PK:S", "SK:S"], flatten([for i in values(jsondecode(file("${path.module}/indexes.json"))) : ["${i.hash}:S", "${i.range}:S"]])))
    error_message = "Every declared key attribute must have string type and the exact index shape."
  }
  assert {
    condition     = jsonencode(jsondecode(output.policies.read.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"], Resource = concat([aws_dynamodb_table.this.arn], [for name in keys(jsondecode(file("${path.module}/indexes.json"))) : "${aws_dynamodb_table.this.arn}/index/${name}"]) }] }) && jsonencode(jsondecode(output.policies.write.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"], Resource = [aws_dynamodb_table.this.arn] }] }) && jsonencode(jsondecode(output.policies.delete.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:BatchWriteItem"], Resource = [aws_dynamodb_table.this.arn], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["EV|*"] }, "Null" = { "dynamodb:LeadingKeys" = "false" } } }] })
    error_message = "Store read, write and delete policies must contain only their precise actions and table/index ARNs."
  }
  assert {
    condition     = jsonencode(jsondecode(output.policies["key-read"].primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:GetItem"], Resource = [aws_dynamodb_table.this.arn], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["KEY|*"] }, "Null" = { "dynamodb:LeadingKeys" = "false" } } }] })
    error_message = "Ingest reads only project keys from the table."
  }
  assert {
    condition     = jsonencode(jsondecode(output.policies["metadata-delete"].primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:DeleteItem"], Resource = [aws_dynamodb_table.this.arn], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["ORGSLUG|*", "PROJECTSLUG|*", "TOKEN|*", "RELEASE|*", "KEY|*", "KEYID|*", "DEBUG|*", "BUNDLE|*"] }, "Null" = { "dynamodb:LeadingKeys" = "false" } } }] })
    error_message = "Metadata deletion must be confined to the approved leading-key namespaces."
  }
  assert {
    condition     = alltrue(flatten([for resources in values(output.policies) : [for policy in values(resources) : length(policy) <= 2048]]))
    error_message = "Every policy must fit its Lambda inline-policy budget."
  }
  assert {
    condition     = jsondecode(aws_dynamodb_table_item.store_production_metadata[0].item).projectTimeShards.N == "4" && jsondecode(aws_dynamodb_table_item.store_production_metadata[0].item).PK.S == "META|schema" && jsondecode(aws_dynamodb_table_item.store_production_metadata[0].item).SK.S == "DATA"
    error_message = "The immutable table metadata item must record the default shard count and exact key."
  }
}
run "reject_shard_change" {
  state_key = "store"
  command   = plan
  variables {
    name         = "example"
    tags         = {}
    purpose      = "store"
    index_shards = 3
  }
  expect_failures = [terraform_data.shard_guard]
}
run "disposable_custom_shards" {
  state_key = "disposable"
  command   = apply
  variables {
    name         = "custom"
    tags         = {}
    purpose      = "store"
    protection   = "disposable"
    index_shards = 2
  }
  assert {
    condition     = !aws_dynamodb_table.this.deletion_protection_enabled && jsondecode(aws_dynamodb_table_item.store_disposable_metadata[0].item).projectTimeShards.N == "2"
    error_message = "Disposable tables persist the requested shard count."
  }
}
run "disposable_reject_shard_change" {
  state_key = "disposable"
  command   = plan
  variables {
    name         = "custom"
    tags         = {}
    purpose      = "store"
    protection   = "disposable"
    index_shards = 3
  }
  expect_failures = [terraform_data.shard_guard]
}
run "reject_shard_change_with_protection_transition" {
  state_key = "disposable"
  command   = plan
  variables {
    name         = "custom"
    tags         = {}
    purpose      = "store"
    protection   = "production"
    index_shards = 3
  }
  expect_failures = [terraform_data.shard_guard]
}
run "kv_without_indexes" {
  state_key = "kv"
  command   = apply
  variables {
    name       = "example"
    tags       = {}
    purpose    = "kv"
    protection = "disposable"
  }
  assert {
    condition     = length(aws_dynamodb_table_item.store_production_metadata) == 0 && length(aws_dynamodb_table_item.store_disposable_metadata) == 0 && aws_dynamodb_table.this.name == "example-kv" && length(aws_dynamodb_table.this.global_secondary_index) == 0 && !aws_dynamodb_table.this.deletion_protection_enabled && aws_dynamodb_table.this.ttl[0].attribute_name == "expiresAt" && aws_dynamodb_table.this.ttl[0].enabled
    error_message = "KV keeps its own index-free TTL and protection contract."
  }
  assert {
    condition     = toset(keys(output.policies)) == toset(["read", "write", "delete"]) && jsonencode(jsondecode(output.policies.read.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"], Resource = [aws_dynamodb_table.this.arn] }] })
    error_message = "KV read policy is restricted to the KV table and has no metadata-delete policy."
  }
  assert {
    condition     = jsonencode(jsondecode(output.policies.write.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"], Resource = [aws_dynamodb_table.this.arn] }] }) && jsonencode(jsondecode(output.policies.delete.primary)) == jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:DeleteItem"], Resource = [aws_dynamodb_table.this.arn] }] })
    error_message = "KV write/delete policies must match its runtime APIs."
  }
}

run "reject_too_many_shards" {
  command = plan
  variables {
    name         = "invalid"
    tags         = {}
    purpose      = "store"
    index_shards = 5
  }
  expect_failures = [var.index_shards]
}
run "reject_fractional_shards" {
  command = plan
  variables {
    name         = "invalid"
    tags         = {}
    purpose      = "store"
    index_shards = 1.5
  }
  expect_failures = [var.index_shards]
}
