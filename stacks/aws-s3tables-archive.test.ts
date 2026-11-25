import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  icebergArchive,
  s3TablesArchive,
} from "@moriyoshi/errtraq-archive-iceberg/stack";
import {
  deriveDeployment,
  resolveStack,
  type StackConfig,
} from "@moriyoshi/errtraq-core";
import { describe, expect, it } from "vitest";
import { generate } from "../packages/infra-gen/src/index.js";
import perTopic from "./aws-dynamodb-per-topic.js";

const base = Object.fromEntries(Object.entries(perTopic)) as StackConfig;
const options = {
  outputDirectory: "infra/generated/example",
  modulesDirectory: "infra/modules",
  generationEnv: {},
  artifactPaths: Object.fromEntries(
    ["ingest", "api", "consumer", "record", "cron", "shared"].map((id) => [
      id,
      `build/${id}.zip`,
    ]),
  ),
};
function generated(archive: StackConfig["archive"]): Record<string, unknown> {
  const stack = resolveStack({ ...base, archive });
  const result = generate(stack, options);
  if (result.kind !== "terraform") throw new Error(result.reason);
  return JSON.parse(result.files["main.tf.json"] ?? "{}").module;
}

describe("AWS stack with the S3 Tables archive", () => {
  it("generates the s3tables module with stack values and config inputs", () => {
    const modules = generated(
      s3TablesArchive({ region: "us-east-1", namespace: "events_ns" }),
    ) as Record<string, Record<string, unknown>>;
    const archive = modules.archive;
    expect(archive?.source).toMatch(/modules\/aws\/s3tables$/);
    expect(archive).toMatchObject({ namespace: "events_ns" });
    expect(Object.keys(archive ?? {}).sort()).toEqual([
      "name",
      "namespace",
      "protection",
      "source",
      "tags",
    ]);
  });
  it("grants read to the API and read, write and delete to the roles that run the archive", () => {
    const stack = resolveStack({
      ...base,
      archive: s3TablesArchive({ region: "us-east-1" }),
    });
    const grants = new Map<string, string[]>();
    for (const fn of deriveDeployment(stack).functions)
      for (const grant of fn.policies.filter((g) => g.selection === "archive"))
        for (const role of fn.roles)
          grants.set(role, [...(grants.get(role) ?? []), grant.capability]);
    expect(grants.get("api")?.sort()).toEqual(["read"]);
    expect(grants.get("consumer")?.sort()).toEqual(["delete", "read", "write"]);
    expect(grants.get("cron")?.sort()).toEqual(["delete", "read", "write"]);
    expect(grants.has("ingest")).toBe(false);
  });
  it("declares exactly the HCL module's outputs, variables and policy leaves", () => {
    const directory = resolve("infra/modules/aws/s3tables");
    const read = (file: string) =>
      readFileSync(resolve(directory, file), "utf8");
    const selection = s3TablesArchive({ region: "us-east-1" });
    const outputs = [...read("outputs.tf").matchAll(/^output "(\w+)"/gm)]
      .map((match) => match[1])
      .sort();
    expect(outputs).toEqual(Object.keys(selection.infra.module.outputs).sort());
    const variables = [
      ...read("variables.tf").matchAll(/^variable "(\w+)"/gm),
    ].map((match) => match[1]);
    expect(
      Object.keys(
        selection.infra.inputs(selection.config as never, {} as never),
      ).filter((name) => !variables.includes(name)),
    ).toEqual([]);
    const shapes = JSON.parse(
      readFileSync(resolve("infra/modules/aws/output-shapes.json"), "utf8"),
    ).s3tables;
    expect(Object.keys(shapes).sort()).toEqual(outputs);
    expect(shapes.policies).toEqual({
      delete: { primary: "json-document" },
      read: { primary: "json-document" },
      write: { primary: "json-document" },
    });
  });
  it("generates nothing for an existing catalog and its supplied outputs", () => {
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [] });
    const modules = generated(
      icebergArchive(
        { catalog: { uri: "http://x.test", warehouse: "w" } },
        {
          existing: {
            table_bucket_arn:
              "arn:aws:s3tables:us-east-1:123456789012:bucket/b",
            catalog_uri: "https://s3tables.us-east-1.amazonaws.com/iceberg",
            region: "us-east-1",
            policies: Object.fromEntries(
              ["read", "write", "delete"].map((c) => [c, { primary: policy }]),
            ),
          },
        },
      ),
    );
    expect(modules).not.toHaveProperty("archive");
  });
});
