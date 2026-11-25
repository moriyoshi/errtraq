import { s3TablesArchive } from "@moriyoshi/errtraq-archive-iceberg/stack";
import {
  deployedPlan,
  deriveDeployment,
  resolveStack,
  type StackConfig,
  validateStack,
} from "@moriyoshi/errtraq-core";
import { awsLambda } from "@moriyoshi/errtraq-platform-aws-lambda/stack";
import { sqsQueue } from "@moriyoshi/errtraq-queue-sqs/stack";
import { describe, expect, it } from "vitest";
import { generate } from "../packages/infra-gen/src/index.js";
import example from "./aws-dynamodb-archive.js";

const raw = Object.fromEntries(Object.entries(example)) as StackConfig;
const files = () => {
  const result = generate(example, {
    outputDirectory: "infra/generated/example",
    modulesDirectory: "infra/modules",
    generationEnv: {},
    artifactPaths: Object.fromEntries(
      ["ingest", "api", "consumer", "record", "cron", "archive"].map((id) => [
        id,
        `build/${id}.zip`,
      ]),
    ),
  });
  if (result.kind !== "terraform") throw new Error(result.reason);
  return result.files;
};

describe("DynamoDB stack with the S3 Tables archive (M4i)", () => {
  it("adds the always-split archive role and runs it and the API from the image", () => {
    const view = deriveDeployment(example);
    expect(view.functions.map((fn) => fn.id)).toEqual([
      "ingest",
      "api",
      "consumer",
      "record",
      "cron",
      "archive",
    ]);
    const main = JSON.parse(files()["main.tf.json"] ?? "{}") as {
      module: {
        platform: {
          image_uri: string;
          functions: Record<
            string,
            {
              package_type: string;
              architecture: string;
              memory_mb: number;
              timeout_sec: number;
              ephemeral_storage_mb: number;
              environment: Record<string, string>;
            }
          >;
          queue_triggers: Record<
            string,
            {
              function_id: string;
              topics: string[];
              batch_size?: number;
              max_concurrency?: number;
              visibility_timeout_sec: number;
            }
          >;
          cron_triggers: Record<string, { function_id: string }>;
        };
      };
    };
    const platform = main.module.platform;
    expect(platform.image_uri).toBe("$" + "{var.image_uri}");
    expect(
      Object.fromEntries(
        Object.entries(platform.functions).map(([id, fn]) => [
          id,
          fn.package_type,
        ]),
      ),
    ).toEqual({
      ingest: "Zip",
      api: "Image",
      consumer: "Zip",
      record: "Zip",
      cron: "Zip",
      archive: "Image",
    });
    expect(platform.functions.archive).toMatchObject({
      architecture: "arm64",
      memory_mb: 1024,
      timeout_sec: 300,
      ephemeral_storage_mb: 2048,
    });
    expect(platform.functions.api).toMatchObject({
      architecture: "arm64",
      memory_mb: 1024,
    });
    expect(platform.functions.consumer?.architecture).toBe("x86_64");
    // The catalog location reaches exactly the functions that use the archive.
    for (const id of ["api", "archive"])
      expect(Object.keys(platform.functions[id]?.environment ?? {})).toEqual(
        expect.arrayContaining([
          "ERRTRAQ_ARCHIVE_WAREHOUSE",
          "ERRTRAQ_ARCHIVE_CATALOG_URI",
          "ERRTRAQ_ARCHIVE_REGION",
        ]),
      );
    for (const id of ["ingest", "consumer", "cron", "record"])
      expect(
        Object.keys(platform.functions[id]?.environment ?? {}).some((name) =>
          name.startsWith("ERRTRAQ_ARCHIVE_"),
        ),
      ).toBe(false);
    expect(platform.queue_triggers.archive_project).toMatchObject({
      function_id: "archive",
      topics: ["archive.project"],
      batch_size: 1,
      max_concurrency: 5,
      visibility_timeout_sec: 1800,
    });
    expect(platform.queue_triggers.ingest?.function_id).toBe("consumer");
    expect(
      Object.fromEntries(
        Object.entries(platform.cron_triggers).map(([job, trigger]) => [
          job,
          trigger.function_id,
        ]),
      ),
    ).toEqual({
      "staged-recovery": "cron",
      "bundle-cleanup": "cron",
      "archive-planner": "archive",
      retention: "archive",
    });
  });
  it("delivers the stack-wide archive retention to the archive function's plan only", () => {
    expect(deployedPlan(example, "archive").archiveRetentionDays).toBe(730);
    expect(
      deployedPlan(example, "archive").queueConsumers.map((c) => c.topics),
    ).toEqual([["archive.project"]]);
    expect(
      deployedPlan(example, "consumer").queueConsumers.map((c) => c.topics),
    ).toEqual([["ingest"]]);
  });
  it("outputs the repository the image is pushed to", () => {
    const outputs = JSON.parse(files()["outputs.tf.json"] ?? "{}") as {
      output: Record<string, { value: string }>;
    };
    expect(outputs.output.image_repository_url?.value).toBe(
      "$" + "{module.platform.image_repository_url}",
    );
  });
  it("rejects stacks that cannot work", () => {
    // The image function needs its URI.
    expect(() =>
      resolveStack({ ...raw, platform: awsLambda() } as StackConfig),
    ).toThrow("need the platform config imageUri");
    // archive.project and ingest cannot share one queue (one event-source mapping per queue).
    expect(
      validateStack({ ...raw, queue: sqsQueue({ mode: "shared" }) }).map(
        (issue) => issue.message,
      ),
    ).toContain(
      "Queue shared carries topics consumed by different functions; use a per-topic queue",
    );
    // The API reads through the engine, so it cannot share a function with the ingest role.
    expect(
      validateStack({
        ...raw,
        platform: awsLambda({
          imageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/x:v1",
          split: ["ingest", "consumer", "cron"],
        }),
      }).map((issue) => issue.message),
    ).toContain(
      "With an archive the api role must be split into its own function",
    );
    // Image functions are built for one architecture.
    expect(() =>
      resolveStack({
        ...raw,
        platform: awsLambda({
          imageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/x:v1",
          settings: { archive: { architecture: "x86_64" } },
        }),
      } as StackConfig),
    ).toThrow("cannot use x86_64");
    // Retention bounds need an archive.
    const { archive: _archive, ...plain } = raw;
    expect(
      validateStack({ ...plain, platform: awsLambda() }).map(
        (issue) => issue.message,
      ),
    ).toContain("archiveRetentionDays requires an archive");
  });
  it("selects the preinstalled-extension engine settings of the image", () => {
    const { config } = s3TablesArchive({ region: "us-east-1" });
    expect(config).toMatchObject({
      engine: {
        catalogType: "s3_tables",
        extensionMode: "preinstalled",
        extensionDirectory: "/opt/errtraq/duckdb-extensions",
        memoryLimit: "704MB",
        threads: 2,
      },
    });
  });
});
