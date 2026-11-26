import { s3Blob } from "@moriyoshi/errtraq-blob-s3/stack";
import { defineStack, output, variable } from "@moriyoshi/errtraq-core";
import { dynamoKv } from "@moriyoshi/errtraq-kv-dynamodb/stack";
import { awsLambda } from "@moriyoshi/errtraq-platform-aws-lambda/stack";
import { sqsQueue } from "@moriyoshi/errtraq-queue-sqs/stack";
import { dynamoStore } from "@moriyoshi/errtraq-store-dynamodb/stack";

// The web UI on CloudFront (same origin as the API, /api/0/*), next to the DSN host. Build the UI
// first (`pnpm --filter @moriyoshi/errtraq-ui build`), then `errtraq build` copies it into the
// build output and Terraform uploads exactly those files.
export default defineStack({
  name: "aws-dynamodb-ui",
  providers: {
    aws: {
      source: "hashicorp/aws",
      version: ">= 6.32.1, < 7.0",
      region: "us-east-1",
      tags: { app: "errtraq" },
    },
  },
  platform: awsLambda({
    // Relative to this file; the build copy, not this directory, is what Terraform reads.
    ui: { directory: "../packages/ui/dist" },
    // Optional: the DSN host shown in the UI's key list. A custom domain in front of the ingest
    // function URL goes here; it cannot be derived from the function's own URL output.
    publicIngestUrl: variable("ingest_public_url"),
  }),
  store: dynamoStore(),
  queue: sqsQueue({ mode: "shared" }),
  blob: s3Blob(),
  kv: dynamoKv(),
  variables: {
    ingest_public_url: {
      type: "string",
      sensitive: false,
      default: "https://ingest.example.com",
    },
  },
  outputs: {
    ingest_url: output("platform", "ingest_url"),
    api_url: output("platform", "api_url"),
    ui_domain_name: output("platform", "ui_domain_name"),
    ui_distribution_id: output("platform", "ui_distribution_id"),
    ui_bucket_name: output("platform", "ui_bucket_name"),
  },
});
