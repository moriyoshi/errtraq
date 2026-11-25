import { gcsBlob } from "@moriyoshi/errtraq-blob-gcs/stack";
import { defineStack, output, variable } from "@moriyoshi/errtraq-core";
import { firestoreKv } from "@moriyoshi/errtraq-kv-firestore/stack";
import { cloudRun } from "@moriyoshi/errtraq-platform-cloud-run/stack";
import { pubsubQueue } from "@moriyoshi/errtraq-queue-pubsub/stack";
import { firestoreStore } from "@moriyoshi/errtraq-store-firestore/stack";
import { IMAGE_VARIABLE, requiredEnv } from "./gcp-env.js";

const projectId = requiredEnv("ERRTRAQ_GCP_PROJECT");
const region = requiredEnv("ERRTRAQ_GCP_REGION");

/** Cloud Run, Firestore (store and KV), Pub/Sub push, GCS. No archive tier on GCP yet. */
export default defineStack({
  name: "gcp-firestore",
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
  store: firestoreStore({ projectId, location: region }),
  queue: pubsubQueue({ projectId, region, mode: "shared" }),
  blob: gcsBlob({ location: region }),
  kv: firestoreKv({ projectId, location: region }),
  outputs: {
    ingest_url: output("platform", "ingest_url"),
    api_url: output("platform", "api_url"),
  },
});
