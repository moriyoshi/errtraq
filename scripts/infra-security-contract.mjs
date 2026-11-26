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
 * wildcard permissions in custom roles, no `allUsers` member, and `invoker_iam_disabled` only from the public flag.
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
    if (/"allUsers"/.test(text))
      violations.push(
        `${file}: allUsers member (public services use invoker_iam_disabled)`,
      );
    for (const match of text.matchAll(/invoker_iam_disabled\s*=\s*([^\n]*)/g))
      if (match[1].trim() !== "each.value.public")
        violations.push(
          `${file}: invoker_iam_disabled not tied to the public flag (${match[1].trim()})`,
        );
  }
  return violations;
}

/**
 * Source-level rules for the web UI static site: the bucket blocks public access, only the
 * distribution may read it (origin access control, a bucket policy tied to its ARN), the API
 * origin does not use origin access control (it would replace the Bearer token), nothing is served
 * over plain HTTP, and there are no distribution-wide custom error responses (they would rewrite
 * the API's 403 and 404 JSON into index.html). Returns the violations in `main.tf` (empty when clean).
 */
export function staticSiteContract(directory) {
  const text = readFileSync(resolve(directory, "main.tf"), "utf8");
  const violations = [];
  const block = text.match(
    /resource "aws_s3_bucket_public_access_block" "site" \{([\s\S]*?)\n\}/,
  )?.[1];
  for (const setting of [
    "block_public_acls",
    "block_public_policy",
    "ignore_public_acls",
    "restrict_public_buckets",
  ])
    if (!block || !new RegExp(`${setting}\\s*=\\s*true`).test(block))
      violations.push(`bucket does not set ${setting} = true`);
  if (/custom_error_response/.test(text))
    violations.push("custom_error_response rewrites the API's error JSON");
  const controls = [
    ...text.matchAll(
      /resource "aws_cloudfront_origin_access_control" "[^"]+" \{([\s\S]*?)\n\}/g,
    ),
  ];
  if (controls.length !== 1)
    violations.push("exactly one origin access control is expected");
  for (const control of controls)
    if (!/signing_behavior\s*=\s*"always"/.test(control[1] ?? ""))
      violations.push("origin access control must always sign");
  const api = text.match(
    /origin \{\s*origin_id\s*=\s*"api"([\s\S]*?)\n {2}\}/,
  )?.[1];
  if (!api) violations.push("API origin not found");
  else if (/origin_access_control_id/.test(api))
    violations.push("API origin must not use origin access control");
  if (/viewer_protocol_policy\s*=\s*"allow-all"/.test(text))
    violations.push("viewer_protocol_policy allow-all");
  const policy = text.match(
    /resource "aws_s3_bucket_policy" "site" \{([\s\S]*?)\n\}/,
  )?.[1];
  if (!policy) violations.push("bucket policy not found");
  else {
    const allows = policy.match(/Effect\s*=\s*"Allow"/g)?.length ?? 0;
    const scoped =
      policy.match(
        /Principal\s*=\s*\{ Service = "cloudfront\.amazonaws\.com" \}[\s\S]*?"AWS:SourceArn"\s*=\s*aws_cloudfront_distribution\.site\.arn/g,
      )?.length ?? 0;
    if (allows === 0 || allows !== scoped)
      violations.push(
        "every Allow must name the CloudFront principal and this distribution",
      );
    for (const action of policy.matchAll(
      /Action\s*=\s*(?:"([^"]+)"|\[([^\]]*)\])/g,
    ))
      if (
        /\*/.test(action[1] ?? action[2] ?? "") &&
        !/Deny/.test(
          policy
            .slice(0, action.index ?? 0)
            .split("Effect")
            .pop() ?? "",
        )
      )
        violations.push(`wildcard action ${action[1] ?? action[2]}`);
  }
  return violations;
}
