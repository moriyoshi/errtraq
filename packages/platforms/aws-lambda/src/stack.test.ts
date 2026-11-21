import { resolveStack, validateStack, variable } from "@errtraq/core";
import { expect, it } from "vitest";
import shared from "../../../../stacks/aws-dynamodb.js";
import { awsLambda } from "./stack.js";

it("requires subnet and security group IDs together", () => {
  expect(() => awsLambda({ vpcSubnetIds: ["subnet-12345678"] })).toThrow();
  expect(() => awsLambda({ vpcSecurityGroupIds: ["sg-12345678"] })).toThrow();
  expect(() =>
    awsLambda({
      vpcSubnetIds: ["subnet-invalid"],
      vpcSecurityGroupIds: ["sg-12345678"],
    }),
  ).toThrow();
  expect(awsLambda().config).toMatchObject({
    vpcSubnetIds: [],
    vpcSecurityGroupIds: [],
  });
});
it("preserves stack variable references for existing VPC IDs", () => {
  const platform = awsLambda({
    vpcSubnetIds: variable("SUBNETS"),
    vpcSecurityGroupIds: variable("GROUPS"),
  });
  const stack = {
    ...Object.fromEntries(Object.entries(shared)),
    platform,
    recordMode: "direct",
    variables: {
      SUBNETS: {
        type: "string[]",
        sensitive: false,
        default: ["subnet-12345678"],
      },
      GROUPS: { type: "string[]", sensitive: false, default: ["sg-12345678"] },
    },
  };
  expect(validateStack(stack)).toEqual([]);
  expect(
    validateStack({
      ...stack,
      variables: {
        ...stack.variables,
        SUBNETS: { type: "string", sensitive: false },
      },
    }).some((issue) =>
      issue.message.includes(
        "Infrastructure config variable must have type string[]",
      ),
    ),
  ).toBe(true);
  const resolved = resolveStack(stack);
  const inputs = platform.infra.inputs(platform.config, {
    functions: [],
    triggers: [],
  } as never);
  expect(inputs.vpc_subnet_ids).toEqual(variable("SUBNETS"));
  expect(inputs.vpc_security_group_ids).toEqual(variable("GROUPS"));
  expect(resolved.platform.config).toBeDefined();
});
