import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  dynamoMetadataProtection,
  googleRoleContract,
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
