import { s3TablesArchive } from "@moriyoshi/errtraq-archive-iceberg/stack";
import { s3Blob } from "@moriyoshi/errtraq-blob-s3/stack";
import { defineStack, output, variable } from "@moriyoshi/errtraq-core";
import { dynamoKv } from "@moriyoshi/errtraq-kv-dynamodb/stack";
import { awsLambda } from "@moriyoshi/errtraq-platform-aws-lambda/stack";
import { sqsQueue } from "@moriyoshi/errtraq-queue-sqs/stack";
import { dynamoStore } from "@moriyoshi/errtraq-store-dynamodb/stack";

/**
 * DynamoDB active store, SQS, S3 and the S3 Tables archive (M4i). The `archive` role (worker,
 * planner and housekeeping) and the `api` role run from one container image built by
 * `errtraq build`; push it to the generated ECR repository, then set `image_uri`.
 * `archive.project` needs its own queue, so the queue is per-topic. Hot events older than a
 * project's `retentionDays` move to the archive; `archiveRetentionDays` bounds their total life.
 */
export default defineStack({
  name: "aws-dynamodb-archive",
  providers: {
    aws: {
      source: "hashicorp/aws",
      version: ">= 6.32.1, < 7.0",
      region: "us-east-1",
      tags: { app: "errtraq" },
    },
  },
  variables: {
    image_uri: { type: "string", sensitive: false },
  },
  archiveRetentionDays: 730,
  platform: awsLambda({ imageUri: variable("image_uri") }),
  store: dynamoStore(),
  queue: sqsQueue({ mode: "per-topic" }),
  blob: s3Blob(),
  archive: s3TablesArchive({ region: "us-east-1" }),
  kv: dynamoKv(),
  outputs: {
    ingest_url: output("platform", "ingest_url"),
    api_url: output("platform", "api_url"),
    image_repository_url: output("platform", "image_repository_url"),
  },
});
