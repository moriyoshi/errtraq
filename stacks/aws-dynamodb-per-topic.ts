import { s3Blob } from "@moriyoshi/errtraq-blob-s3/stack";
import { defineStack, output } from "@moriyoshi/errtraq-core";
import { dynamoKv } from "@moriyoshi/errtraq-kv-dynamodb/stack";
import { awsLambda } from "@moriyoshi/errtraq-platform-aws-lambda/stack";
import { sqsQueue } from "@moriyoshi/errtraq-queue-sqs/stack";
import { dynamoStore } from "@moriyoshi/errtraq-store-dynamodb/stack";

export default defineStack({
  name: "aws-dynamodb-per-topic",
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
  queue: sqsQueue({ mode: "per-topic" }),
  blob: s3Blob(),
  kv: dynamoKv(),
  outputs: {
    ingest_url: output("platform", "ingest_url"),
    api_url: output("platform", "api_url"),
  },
});
