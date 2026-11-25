import { readdirSync, readFileSync } from "node:fs";
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

/**
 * Source-level rules for the Google modules (GCP_PLAN 5.2): no primitive or administrative roles, no
 * wildcard permissions in custom roles, and `allUsers` only on the public Cloud Run invoker bindings.
 * Returns the violations found in the `.tf` files of one module directory (empty when clean).
 */
export function googleRoleContract(directory) {
  const violations = [];
  for (const file of readdirSync(directory).filter((f) => f.endsWith(".tf"))) {
    const text = readFileSync(resolve(directory, file), "utf8");
    for (const match of text.matchAll(/"(roles\/[A-Za-z0-9_.]+)"/g)) {
      const role = match[1];
      if (
        /^roles\/(owner|editor|viewer)$/.test(role) ||
        /\.(admin|owner|editor)$/.test(role) ||
        /^roles\/(iam\.serviceAccountUser|iam\.serviceAccountAdmin|resourcemanager\.)/.test(
          role,
        ) ||
        // Pub/Sub, Secret Manager and Cloud SQL have narrower roles for every use here.
        /^roles\/(pubsub\.editor|cloudsql\.editor|storage\.objectAdmin|datastore\.owner)$/.test(
          role,
        )
      )
        violations.push(`${file}: broad role ${role}`);
    }
    for (const match of text.matchAll(/permissions\s*=\s*(\[[^\]]*\]|[^\n]*)/g))
      if (/\*/.test(match[1]) && !/each\.value|var\./.test(match[1]))
        violations.push(`${file}: wildcard permission ${match[1]}`);
    if (/allAuthenticatedUsers/.test(text))
      violations.push(`${file}: allAuthenticatedUsers member`);
    if (/"allUsers"/.test(text)) {
      const resources = [
        ...text.matchAll(/resource "(\w+)" "(\w+)" \{([\s\S]*?)\n\}/g),
      ];
      for (const [, type, name, body] of resources)
        if (
          /"allUsers"/.test(body) &&
          !(
            type === "google_cloud_run_v2_service_iam_member" &&
            name === "public" &&
            /roles\/run\.invoker/.test(body)
          )
        )
          violations.push(
            `${file}: allUsers outside the public invoker binding (${type}.${name})`,
          );
    }
  }
  return violations;
}
