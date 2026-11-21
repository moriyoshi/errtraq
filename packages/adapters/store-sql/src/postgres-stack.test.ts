import { resolveStack, validateStack, variable } from "@errtraq/core";
import { expect, it } from "vitest";
import local from "../../../../stacks/local.js";
import { constructStack } from "../../../cli/src/construction.js";
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
