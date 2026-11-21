import {
  deriveDeployment,
  resolveStack,
  validateStack,
  variable,
} from "@errtraq/core";
import { expect, it } from "vitest";
import local from "../../../../stacks/local.js";
import { constructStack } from "../../../cli/src/construction.js";
import { formatValidation } from "../../../cli/src/validation.js";
import { postgres } from "./postgres-stack.js";

it("constructs a bring-your-own Postgres using a local secret identifier", async () => {
  const stack = {
    ...Object.fromEntries(Object.entries(local)),
    variables: {
      connection_secret: {
        type: "string" as const,
        sensitive: false,
        default: "DATABASE_URL",
      },
    },
    store: postgres(variable("connection_secret")),
  };
  expect(validateStack(stack)).toEqual([]);
  const constructed = await constructStack(
    resolveStack(stack),
    ["ingest", "api", "consumer", "cron"],
    { DATABASE_URL: "postgresql://user:password@localhost/db" },
    async (module) =>
      module === "@errtraq/store-sql/postgres"
        ? import("./postgres.js")
        : { create: () => ({}) },
  );
  expect(constructed.instances.get("store")).toHaveProperty("recordEvent");
  await constructed.close();
});

it("validates IAM configuration and requires AWS credentials from the platform", async () => {
  const { default: aws } = await import("../../../../stacks/aws-dynamodb.js");
  const iam = postgres({
    mode: "iam",
    host: "db.example.rds.amazonaws.com",
    port: 5432,
    database: "errtraq",
    user: "app",
    region: "us-east-1",
    resourceId: "db-ABC123",
  });
  const stack = { ...Object.fromEntries(Object.entries(aws)), store: iam };
  expect(validateStack(stack)).toEqual([]);
  expect(formatValidation(resolveStack(stack))).toContain(
    "IAM grants connection to one PostgreSQL user; PostgreSQL privileges enforce read, write and delete.",
  );
  const view = deriveDeployment(resolveStack(stack));
  for (const fn of view.functions.filter((item) =>
    item.roles.some((role) => ["ingest", "api", "record"].includes(role)),
  )) {
    expect(
      fn.envBindings
        .filter((item) => item.selection === "store")
        .map((item) => item.binding.name),
    ).toContain("ERRTRAQ_POSTGRES_HOST");
    expect(
      fn.secretBindings.filter((item) => item.selection === "store"),
    ).toHaveLength(0);
  }
  const withCaRef = {
    ...stack,
    variables: {
      ...aws.variables,
      ca_path: { type: "string", sensitive: false, default: "/bundle/rds.pem" },
    },
    store: postgres({
      mode: "iam",
      host: "db.example.rds.amazonaws.com",
      database: "errtraq",
      user: "app",
      region: "us-east-1",
      resourceId: "prx-ABC123",
      sslRootCert: variable("ca_path"),
    }),
  };
  expect(validateStack(withCaRef)).toEqual([]);
  expect(
    withCaRef.store.infra.bindings.find(
      (binding) => binding.name === "ERRTRAQ_POSTGRES_CA_PATH",
    )?.value,
  ).toEqual(variable("ca_path"));
  const wrongPlatform = {
    ...Object.fromEntries(Object.entries(local)),
    store: iam,
  };
  expect(
    validateStack(wrongPlatform).some((issue) =>
      issue.message.includes("aws-credentials"),
    ),
  ).toBe(true);
  const mixed = {
    ...stack,
    store: {
      ...iam,
      config: { ...(iam.config as object), secret: variable("secret") },
    },
  };
  expect(validateStack(mixed).length).toBeGreaterThan(0);
  expect(() =>
    postgres({
      mode: "iam",
      host: "db.example",
      database: "db",
      user: "app",
      region: "us-east-1",
      resourceId: "db-ABC",
      secret: variable("s"),
    } as never),
  ).toThrow();
});
