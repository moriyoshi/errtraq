import { gcsBlob } from "@moriyoshi/errtraq-blob-gcs/stack";
import { defineStack, output, variable } from "@moriyoshi/errtraq-core";
import { firestoreKv } from "@moriyoshi/errtraq-kv-firestore/stack";
import { cloudRun } from "@moriyoshi/errtraq-platform-cloud-run/stack";
import { pubsubQueue } from "@moriyoshi/errtraq-queue-pubsub/stack";
import { postgres } from "@moriyoshi/errtraq-store-sql/postgres/stack";
import { IMAGE_VARIABLE, requiredEnv } from "./gcp-env.ts";

const projectId = requiredEnv("ERRTRAQ_GCP_PROJECT");
const region = requiredEnv("ERRTRAQ_GCP_REGION");
const instance = requiredEnv("ERRTRAQ_GCP_SQL_INSTANCE");

/**
 * Cloud Run with an existing Cloud SQL for PostgreSQL instance (IAM database authentication over
 * the built-in unix socket), Pub/Sub push, GCS, and Firestore for the KV (rate counters).
 */
export default defineStack({
  name: "gcp-cloudsql",
  providers: {
    google: {
      source: "hashicorp/google",
      version: "~> 8.0",
      project: projectId,
      region,
      tags: { app: "errtraq" },
    },
  },
  variables: { [IMAGE_VARIABLE]: { type: "string", sensitive: false } },
  platform: cloudRun({
    projectId,
    region,
    image: variable(IMAGE_VARIABLE),
  }),
  store: postgres({
    mode: "cloudsql-iam",
    instanceConnectionName: `${projectId}:${region}:${instance}`,
    region,
    database: "errtraq",
  }),
  queue: pubsubQueue({ projectId, region, mode: "shared" }),
  blob: gcsBlob({ location: region }),
  kv: firestoreKv({ projectId, location: region }),
  outputs: {
    ingest_url: output("platform", "ingest_url"),
    api_url: output("platform", "api_url"),
  },
});
