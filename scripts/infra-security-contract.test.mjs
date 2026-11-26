import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  dynamoMetadataProtection,
  googleRoleContract,
  staticSiteContract,
} from "./infra-security-contract.mjs";

describe("DynamoDB metadata lifecycle", () => {
  it("protects the production metadata item from destruction", () => {
    expect(dynamoMetadataProtection("infra/modules/aws/dynamodb")).toBe(true);
  });
});

describe("Google role contract", () => {
  const modules = readdirSync("infra/modules/google", {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());
  it("finds modules to check", () => {
    expect(modules.length).toBeGreaterThanOrEqual(6);
  });
  for (const entry of modules)
    it(`${entry.name} grants no broad role or wildcard permission`, () => {
      expect(googleRoleContract(`infra/modules/google/${entry.name}`)).toEqual(
        [],
      );
    });
});

describe("static site contract", () => {
  const source = readFileSync("infra/modules/aws/static-site/main.tf", "utf8");
  mkdirSync(resolve(".agents-workspace/tmp"), { recursive: true });
  const temp = mkdtempSync(resolve(".agents-workspace/tmp/static-site-"));
  afterAll(() => rmSync(temp, { recursive: true, force: true }));
  /** The violations of the module's main.tf after one textual change. */
  function mutated(find, replace) {
    expect(source.split(find).length, find).toBe(2);
    const directory = mkdtempSync(resolve(temp, "m-"));
    writeFileSync(resolve(directory, "main.tf"), source.replace(find, replace));
    return staticSiteContract(directory);
  }
  it("holds for the module", () => {
    expect(staticSiteContract("infra/modules/aws/static-site")).toEqual([]);
  });
  it("flags a custom domain on an old TLS policy", () => {
    expect(mutated('"TLSv1.2_2021"', '"TLSv1"')).toEqual([
      "a custom certificate needs minimum_protocol_version TLSv1.2 or newer",
    ]);
  });
  it("flags a public bucket, a broad or unscoped policy and plain HTTP", () => {
    expect(
      mutated(
        "block_public_policy     = true",
        "block_public_policy     = false",
      ),
    ).toEqual(["bucket does not set block_public_policy = true"]);
    expect(mutated('Action    = "s3:GetObject"', 'Action    = "s3:*"')).toEqual(
      ["wildcard action s3:*"],
    );
    expect(
      mutated(
        'Principal = { Service = "cloudfront.amazonaws.com" }\n        Action    = "s3:GetObject"',
        'Principal = "*"\n        Action    = "s3:GetObject"',
      ),
    ).toEqual([
      "every Allow must name the CloudFront principal and this distribution",
    ]);
    expect(
      mutated(
        '"https-only"\n    allowed_methods          = ["GET", "HEAD", "OPTIONS"',
        '"allow-all"\n    allowed_methods          = ["GET", "HEAD", "OPTIONS"',
      ),
    ).toEqual(["viewer_protocol_policy allow-all"]);
  });
  it("flags custom error responses and origin access control on the API origin", () => {
    expect(
      mutated(
        "  restrictions {",
        "  custom_error_response {\n    error_code = 404\n  }\n  restrictions {",
      ),
    ).toEqual(["custom_error_response rewrites the API's error JSON"]);
    expect(
      mutated(
        "domain_name = local.api_host",
        "domain_name = local.api_host\n    origin_access_control_id = aws_cloudfront_origin_access_control.site.id",
      ),
    ).toEqual(["API origin must not use origin access control"]);
    expect(
      mutated(
        'signing_behavior                  = "always"',
        'signing_behavior                  = "never"',
      ),
    ).toEqual(["origin access control must always sign"]);
  });
});
