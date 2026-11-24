import { s3Blob } from "@moriyoshi/errtraq-blob-s3/stack";
import { defineStack, output } from "@moriyoshi/errtraq-core";
import { dynamoKv } from "@moriyoshi/errtraq-kv-dynamodb/stack";
import { awsLambda } from "@moriyoshi/errtraq-platform-aws-lambda/stack";
import { sqsQueue } from "@moriyoshi/errtraq-queue-sqs/stack";
import { dynamoStore } from "@moriyoshi/errtraq-store-dynamodb/stack";
import { expect, it } from "vitest";
import { bootstrapAwsStack } from "../packages/cli/src/deployed-bootstrap.js";
import { MemoryActiveStore, MemoryKV } from "../packages/testing/src/index.js";

const define = (maxEventRetentionDays?: number) =>
  defineStack({
    name: "aws-dynamodb",
    providers: {
      aws: {
        source: "hashicorp/aws",
        version: ">= 6.32.1, < 7.0",
        region: "us-east-1",
        tags: { app: "errtraq" },
      },
    },
    platform: awsLambda(),
    store: dynamoStore(),
    queue: sqsQueue({ mode: "shared" }),
    blob: s3Blob(maxEventRetentionDays ? { maxEventRetentionDays } : {}),
    kv: dynamoKv(),
    outputs: {
      ingest_url: output("platform", "ingest_url"),
      api_url: output("platform", "api_url"),
    },
  });
async function bootstrap(maxEventRetentionDays?: number) {
  const store = new MemoryActiveStore(),
    kv = new MemoryKV();
  let secret: string | undefined;
  await bootstrapAwsStack(
    define(maxEventRetentionDays),
    { ERRTRAQ_STORE_TABLE: "store-table", ERRTRAQ_KV_TABLE: "kv-table" },
    {
      secretName: "bootstrap",
      ingestUrl: "https://ingest.example/",
      orgSlug: "org",
      projectSlug: "project",
    },
    {
      vault: {
        claim: async (_name, candidate) => {
          secret ??= candidate;
          return { identifier: "arn", value: secret };
        },
      },
      secretSource: { read: async () => "" },
      loadModule: async (name) => ({
        create: () => (name.includes("store-dynamodb") ? store : kv),
      }),
    },
  );
  const org = await store.projects.getOrgBySlug("org");
  if (!org) throw new Error("missing org");
  return (await store.projects.getProjectBySlug(org.id, "project"))
    ?.retentionDays;
}

it("bounds the bootstrapped project's retention by the blob-s3 maximum", async () => {
  expect(await bootstrap(7)).toBe(7);
  expect(await bootstrap()).toBe(30);
  expect(await bootstrap(90)).toBe(30);
});
