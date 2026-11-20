import {
  env,
  generationEnv,
  output,
  stackValue,
  variable,
} from "@errtraq/core";
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

it("resolves runtime environment defaults, suffixes and numbers", () => {
  expect(
    resolveRuntimeValue(
      env("DATA", { defaultValue: ".errtraq", suffix: "/blobs" }),
      "blob",
      local,
      {},
    ),
  ).toBe(".errtraq/blobs");
  expect(
    resolveRuntimeValue(
      env("PORT", { defaultValue: "8787", valueType: "number" }),
      "platform",
      local,
      { PORT: "1234" },
    ),
  ).toBe(1234);
  expect(() =>
    resolveRuntimeValue(
      env("PORT", { valueType: "number" }),
      "platform",
      local,
      { PORT: "bad" },
    ),
  ).toThrow("Invalid environment variable PORT");
});

it("resolves provider-qualified stack values using the owning module by default", () => {
  const stack = {
    ...local,
    providers: {
      aws: {
        source: "hashicorp/aws",
        version: "1",
        region: "us-east-1",
        tags: { owner: "aws" },
      },
      cloudflare: {
        source: "cloudflare/cloudflare",
        version: "1",
        tags: { owner: "cf" },
      },
    },
    blob: {
      ...local.blob,
      infra: {
        ...local.blob.infra,
        module: { ...local.blob.infra.module, provider: "aws" },
      },
    },
  };
  expect(resolveRuntimeValue(stackValue("region"), "blob", stack, {})).toBe(
    "us-east-1",
  );
  expect(
    resolveRuntimeValue(stackValue("tags", "cloudflare"), "blob", stack, {}),
  ).toEqual({ owner: "cf" });
});
