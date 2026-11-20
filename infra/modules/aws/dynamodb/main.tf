# Store item keys are PK=P#<project> and entity-specific SKs; lookup aliases use
# dedicated items. Sparse GSIs are populated only by the relevant item types:
# 1-3: project/status issue lists sorted by lastSeen, firstSeen and count.
# 4: events by issue and receivedAt; 5: project events by receivedAt for archival.
# 6: subject events by receivedAt for bounded erasure; 7: project fingerprint lookup.
# 8: cross-project metadata by state for cron. M3 owns key encoding and sparse items.
resource "aws_dynamodb_table" "this" {
  name                        = "${var.name}-${var.purpose}"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = var.deletion_protection
  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  dynamic "attribute" {
    for_each = var.purpose == "store" ? toset(flatten([for i in range(1, 9) : ["GSI${i}PK", "GSI${i}SK"]])) : toset([])
    content {
      name = attribute.value
      type = "S"
    }
  }
  dynamic "global_secondary_index" {
    for_each = var.purpose == "store" ? toset([for i in range(1, 9) : tostring(i)]) : toset([])
    content {
      name            = "gsi${global_secondary_index.value}"
      hash_key        = "GSI${global_secondary_index.value}PK"
      range_key       = "GSI${global_secondary_index.value}SK"
      projection_type = "ALL"
    }
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  tags = var.tags
}
locals {
  table_and_indexes = [aws_dynamodb_table.this.arn, "${aws_dynamodb_table.this.arn}/index/*"]
  policies = {
    read   = { primary = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query"], Resource = local.table_and_indexes }] }) }
    write  = { primary = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"], Resource = [aws_dynamodb_table.this.arn] }] }) }
    delete = { primary = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["dynamodb:DeleteItem", "dynamodb:BatchWriteItem"], Resource = [aws_dynamodb_table.this.arn] }] }) }
  }
}
