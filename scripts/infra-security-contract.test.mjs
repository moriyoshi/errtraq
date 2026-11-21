import { describe, expect, it } from "vitest";
import { dynamoMetadataProtection } from "./infra-security-contract.mjs";

describe("DynamoDB metadata lifecycle", () => {
  it("protects the production metadata item from destruction", () => {
    expect(dynamoMetadataProtection("infra/modules/aws/dynamodb")).toBe(true);
  });
});
