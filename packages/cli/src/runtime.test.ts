import { env, generationEnv, output, variable } from "@errtraq/core";
import { expect, it } from "vitest";
import local from "../../../stacks/local.js";
import { resolveRuntimeValue } from "./runtime.js";

it("resolves existing outputs, scoped environments and typed Terraform variables", () => {
  const stack = {
    ...local,
    variables: {
      LIST: { type: "string[]" as const, sensitive: true },
      COUNT: { type: "number" as const, sensitive: false },
    },
    blob: { ...local.blob, existing: { bucket: env("BUCKET") } },
  };
  const values = {
    BUCKET: "example",
    TF_VAR_LIST: '["one","two"]',
    TF_VAR_COUNT: "4",
    GEN: "generated",
  };
  expect(
    resolveRuntimeValue(output("blob", "bucket"), "store", stack, values),
  ).toBe("example");
  expect(resolveRuntimeValue(variable("LIST"), "store", stack, values)).toEqual(
    ["one", "two"],
  );
  expect(resolveRuntimeValue(variable("COUNT"), "store", stack, values)).toBe(
    4,
  );
  expect(
    resolveRuntimeValue(generationEnv("GEN"), "store", stack, values),
  ).toBe("generated");
  expect(() =>
    resolveRuntimeValue(variable("LIST"), "store", stack, {
      TF_VAR_LIST: "secret invalid",
    }),
  ).toThrow("Invalid stack variable LIST");
});
