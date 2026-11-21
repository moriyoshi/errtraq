import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Terraform does not expose lifecycle meta-arguments in resource outputs. */
export function dynamoMetadataProtection(directory) {
  const text = readFileSync(resolve(directory, "main.tf"), "utf8");
  const resource = text.match(
    /resource "aws_dynamodb_table_item" "store_production_metadata" \{([\s\S]*?)\n\}/,
  )?.[1];
  return (
    !!resource &&
    /lifecycle\s*\{[^}]*prevent_destroy\s*=\s*true/.test(resource) &&
    /lifecycle\s*\{[^}]*ignore_changes\s*=\s*\[item\]/.test(resource)
  );
}
