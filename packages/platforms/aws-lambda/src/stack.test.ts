import { resolveStack, validateStack, variable } from "@moriyoshi/errtraq-core";
import { expect, it } from "vitest";
import shared from "../../../../stacks/aws-dynamodb.js";
import { awsLambda, lambdaEsbuildTarget } from "./stack.js";

it("defaults to nodejs26.x, keeps nodejs22.x selectable and rejects other runtimes", () => {
  const view = { functions: [], triggers: [] } as never;
  expect(awsLambda().config).toMatchObject({ runtime: "nodejs26.x" });
  const defaulted = awsLambda();
  expect(defaulted.infra.inputs(defaulted.config, view)).toMatchObject({
    runtime: "nodejs26.x",
  });
  expect(awsLambda({ runtime: "nodejs22.x" }).config).toMatchObject({
    runtime: "nodejs22.x",
  });
  for (const bad of ["nodejs20.x", "nodejs24.x", "python3.13", ""])
    expect(() => awsLambda({ runtime: bad as never })).toThrow(
      /nodejs22\.x, nodejs26\.x/,
    );
  expect(lambdaEsbuildTarget("nodejs22.x")).toBe("node22");
  expect(lambdaEsbuildTarget("nodejs26.x")).toBe("node26");
});
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

it("validates the per-key ingest limit including disable", () => {
  expect(awsLambda().config).toMatchObject({ rateLimit: 60 });
  expect(awsLambda({ rateLimit: null }).config).toMatchObject({
    rateLimit: null,
  });
  expect(awsLambda({ rateLimit: 1000 }).config).toMatchObject({
    rateLimit: 1000,
  });
  for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => awsLambda({ rateLimit: limit })).toThrow();
});

it("reserves the platform rate-limit environment name", () => {
  const stack = {
    ...Object.fromEntries(Object.entries(shared)),
    store: {
      ...shared.store,
      infra: {
        ...shared.store.infra,
        bindings: [
          ...shared.store.infra.bindings,
          {
            name: "ERRTRAQ_INGEST_RATE_LIMIT",
            kind: "env" as const,
            purpose: "primary",
            value: "1",
          },
        ],
      },
    },
  };
  expect(validateStack(stack)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        message: expect.stringContaining(
          "Reserved binding name ERRTRAQ_INGEST_RATE_LIMIT",
        ),
      }),
    ]),
  );
});

it("threads an optional validated alarm topic into the module inputs", () => {
  const topic = "arn:aws:sns:us-east-1:000000000000:operators";
  const view = { functions: [], triggers: [] } as never;
  expect(awsLambda().infra.inputs(awsLambda().config, view)).not.toHaveProperty(
    "alarm_topic_arn",
  );
  const platform = awsLambda({ alarmTopicArn: topic });
  expect(platform.infra.inputs(platform.config, view)).toMatchObject({
    alarm_topic_arn: topic,
  });
  for (const bad of [
    "arn:aws:sqs:us-east-1:000000000000:operators",
    "arn:aws:sns:us-east-1:12:operators",
    "operators",
    "",
  ])
    expect(() => awsLambda({ alarmTopicArn: bad })).toThrow();
});

it("accepts an existing artifact bucket or a stack variable", () => {
  expect(
    awsLambda({ artifactBucket: "deployment-artifacts-123" }).config,
  ).toMatchObject({ artifactBucket: "deployment-artifacts-123" });
  expect(() => awsLambda({ artifactBucket: "INVALID" })).toThrow();
  const platform = awsLambda({ artifactBucket: variable("ARTIFACT_BUCKET") });
  const stack = {
    ...Object.fromEntries(Object.entries(shared)),
    platform,
    recordMode: "direct" as const,
    variables: {
      ARTIFACT_BUCKET: {
        type: "string" as const,
        sensitive: false,
        default: "deployment-artifacts-123",
      },
    },
  };
  expect(validateStack(stack)).toEqual([]);
  expect(
    platform.infra.inputs(platform.config, { functions: [], triggers: [] })
      .artifact_bucket,
  ).toEqual(variable("ARTIFACT_BUCKET"));
});
