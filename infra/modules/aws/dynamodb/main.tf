# Sparse string-key indexes; only items participating in an access pattern carry its keys.
locals {
  store_indexes = jsondecode(file("${path.module}/indexes.json"))
  index_arns    = [for name in keys(local.store_indexes) : "${aws_dynamodb_table.this.arn}/index/${name}"]
}
resource "aws_dynamodb_table" "this" {
  # Version the redesigned store name so Terraform cannot silently rewrite the old layout.
  name                        = var.purpose == "store" ? "${var.name}-store-v2" : "${var.name}-kv"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = var.protection == "production"
  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  dynamic "attribute" {
    for_each = var.purpose == "store" ? toset(flatten([for index in values(local.store_indexes) : [index.hash, index.range]])) : toset([])
    content {
      name = attribute.value
      type = "S"
    }
  }
  dynamic "global_secondary_index" {
    for_each = var.purpose == "store" ? local.store_indexes : {}
    content {
      name = global_secondary_index.key
      key_schema {
        attribute_name = global_secondary_index.value.hash
        key_type       = "HASH"
      }
      key_schema {
        attribute_name = global_secondary_index.value.range
        key_type       = "RANGE"
      }
      projection_type = "KEYS_ONLY"
    }
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  ttl {
    attribute_name = var.purpose == "store" ? "ttlEpoch" : "expiresAt"
    enabled        = true
  }
  tags = var.tags
}
# Terraform owns only the immutable schema metadata item. Production and disposable
# resources are separate so production metadata cannot be destroyed before its table.
resource "aws_dynamodb_table_item" "store_production_metadata" {
  count      = var.purpose == "store" && var.protection == "production" ? 1 : 0
  table_name = aws_dynamodb_table.this.name
  hash_key   = "PK"
  range_key  = "SK"
  item       = jsonencode({ PK = { S = "META|schema" }, SK = { S = "DATA" }, projectTimeShards = { N = tostring(var.index_shards) } })
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [item]
  }
}
resource "aws_dynamodb_table_item" "store_disposable_metadata" {
  count      = var.purpose == "store" && var.protection == "disposable" ? 1 : 0
  table_name = aws_dynamodb_table.this.name
  hash_key   = "PK"
  range_key  = "SK"
  item       = jsonencode({ PK = { S = "META|schema" }, SK = { S = "DATA" }, projectTimeShards = { N = tostring(var.index_shards) } })
  lifecycle { ignore_changes = [item] }
}
# Keep the original value in Terraform state across protection-mode changes as well.
resource "terraform_data" "shard_identity" {
  count = var.purpose == "store" ? 1 : 0
  input = var.index_shards
  lifecycle { ignore_changes = [input] }
}
resource "terraform_data" "shard_guard" {
  count = var.purpose == "store" ? 1 : 0
  input = var.index_shards
  lifecycle {
    precondition {
      condition     = terraform_data.shard_identity[0].output == var.index_shards && tonumber(jsondecode(var.protection == "production" ? aws_dynamodb_table_item.store_production_metadata[0].item : aws_dynamodb_table_item.store_disposable_metadata[0].item).projectTimeShards.N) == var.index_shards
      error_message = "index_shards cannot change on an existing table; re-sharding needs a migration."
    }
  }
}
locals {
  table_and_indexes = concat([aws_dynamodb_table.this.arn], var.purpose == "store" ? local.index_arns : [])
  policies = merge({
    read   = { primary = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"], Resource = local.table_and_indexes }] }) }
    write  = { primary = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"], Resource = [aws_dynamodb_table.this.arn] }] }) }
    delete = { primary = jsonencode({ Version = "2012-10-17", Statement = [merge({ Effect = "Allow", Action = var.purpose == "store" ? ["dynamodb:BatchWriteItem"] : ["dynamodb:DeleteItem"], Resource = [aws_dynamodb_table.this.arn] }, var.purpose == "store" ? { Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["EV|*"] }, "Null" = { "dynamodb:LeadingKeys" = "false" } } } : {})] }) }
    }, var.purpose == "store" ? {
    metadata-delete = { primary = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:DeleteItem"], Resource = [aws_dynamodb_table.this.arn], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["ORGSLUG|*", "PROJECTSLUG|*", "TOKEN|*", "RELEASE|*", "KEY|*", "KEYID|*", "DEBUG|*", "BUNDLE|*"] }, "Null" = { "dynamodb:LeadingKeys" = "false" } } }] }) }
  } : {})
}
