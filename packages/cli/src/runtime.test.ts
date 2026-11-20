import {
  env,
  generationEnv,
  output,
  stackValue,
  validateStack,
  variable,
} from "@errtraq/core";
import { expect, it } from "vitest";
import local from "../../../stacks/local.js";
import { resolveRoleBindings, resolveRuntimeValue } from "./runtime.js";

const copyStack = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value)) as T;

it("resolves existing outputs, scoped environments and typed Terraform variables", () => {
  const stack = {
    ...copyStack(local),
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

it("parses JSON TF_VAR values into native objects or arrays and rejects scalars", () => {
  const stack = {
    ...copyStack(local),
    variables: { DOCUMENT: { type: "json" as const, sensitive: false } },
  };
  expect(
    resolveRuntimeValue(variable("DOCUMENT"), "store", stack, {
      TF_VAR_DOCUMENT: '{"a":[1]}',
    }),
  ).toEqual({ a: [1] });
  expect(
    resolveRuntimeValue(variable("DOCUMENT"), "store", stack, {
      TF_VAR_DOCUMENT: "[1,2]",
    }),
  ).toEqual([1, 2]);
  const literal = ["$", "{aws:username} %{if}"].join("");
  expect(
    resolveRuntimeValue(variable("DOCUMENT"), "store", stack, {
      TF_VAR_DOCUMENT: JSON.stringify({ literal }),
    }),
  ).toEqual({ literal });
  for (const value of ['"text"', "null", "3", "not-json"]) {
    expect(() =>
      resolveRuntimeValue(variable("DOCUMENT"), "store", stack, {
        TF_VAR_DOCUMENT: value,
      }),
    ).toThrow("Invalid stack variable DOCUMENT");
  }
});

it("resolves only the requested key of an existing output map", () => {
  const stack = {
    ...copyStack(local),
    blob: {
      ...local.blob,
      existing: {
        buckets: { primary: { url: env("PRIMARY") }, unused: env("UNUSED") },
      },
    },
  };
  expect(
    resolveRuntimeValue(
      output("blob", "buckets", "primary", "url"),
      "store",
      stack,
      { PRIMARY: "ok" },
    ),
  ).toBe("ok");
  expect(() =>
    resolveRuntimeValue(
      output("blob", "buckets", "missing"),
      "store",
      stack,
      {},
    ),
  ).toThrow("not available");
});

it("rejects local adapters on ephemeral or multi-function compute", () => {
  expect(validateStack(local)).toEqual([]);
  const lambda = {
    ...copyStack(local),
    platform: {
      ...local.platform,
      manifest: {
        ...local.platform.manifest,
        id: "fake-lambda",
        compute: "function" as const,
        authorization: "iam" as const,
        provides: [],
      },
    },
  };
  const issues = validateStack(lambda);
  for (const name of ["store", "queue", "kv", "blob"]) {
    expect(
      issues.some((issue) => issue.path === `${name}.manifest.requires`),
    ).toBe(true);
  }
  const multi = {
    ...lambda,
    platform: {
      ...lambda.platform,
      manifest: {
        ...lambda.platform.manifest,
        compute: "long-lived" as const,
        provides: [...local.platform.manifest.provides],
      },
      config: {
        roles: ["ingest", "api", "consumer", "cron"],
        split: ["api"],
      },
    },
  };
  const multiIssues = validateStack(multi);
  for (const name of ["store", "queue", "kv", "blob"]) {
    expect(
      multiIssues.some(
        (issue) =>
          issue.path === `${name}.manifest.requires` &&
          issue.message.includes("shared-process-state"),
      ),
    ).toBe(true);
  }
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

it("resolves only the bindings used by the requested runtime roles", () => {
  const stack = {
    ...copyStack(local),
    store: {
      ...local.store,
      infra: {
        ...local.store.infra,
        bindings: [
          {
            name: "DB",
            kind: "env" as const,
            purpose: "primary",
            value: env("DB"),
          },
        ],
      },
    },
  };
  expect(resolveRoleBindings(stack, ["cron"], "store", {})).toEqual({});
  expect(resolveRoleBindings(stack, ["ingest"], "store", { DB: "db" })).toEqual(
    { DB: "db" },
  );
  expect(() => resolveRoleBindings(stack, ["api"], "store", {})).toThrow(
    "Missing environment variable DB",
  );
});

it("resolves provider-qualified stack values using the owning module by default", () => {
  const stack = {
    ...copyStack(local),
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

it("uses the selection provider alias for unqualified provider values", () => {
  const stack = {
    ...copyStack(local),
    providers: {
      aws_eu: {
        source: "hashicorp/aws",
        version: "~> 6.0",
        region: "eu-west-1",
        tags: { team: "eu" },
      },
    },
    blob: {
      ...local.blob,
      provider: "aws_eu",
      infra: {
        ...local.blob.infra,
        module: { ...local.blob.infra.module, provider: "aws" },
      },
    },
  };
  expect(resolveRuntimeValue(stackValue("region"), "blob", stack, {})).toBe(
    "eu-west-1",
  );
  expect(resolveRuntimeValue(stackValue("tags"), "blob", stack, {})).toEqual({
    team: "eu",
  });
});
