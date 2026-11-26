import { gcsBlob } from "@moriyoshi/errtraq-blob-gcs/stack";
import { defineStack, output, variable } from "@moriyoshi/errtraq-core";
import { firestoreKv } from "@moriyoshi/errtraq-kv-firestore/stack";
import { cloudRun } from "@moriyoshi/errtraq-platform-cloud-run/stack";
import { pubsubQueue } from "@moriyoshi/errtraq-queue-pubsub/stack";
import { firestoreStore } from "@moriyoshi/errtraq-store-firestore/stack";
import { IMAGE_VARIABLE, requiredEnv } from "./gcp-env.js";

const projectId = requiredEnv("ERRTRAQ_GCP_PROJECT");
const region = requiredEnv("ERRTRAQ_GCP_REGION");

/**
 * The Firestore stack with one Pub/Sub topic, push subscription and dead-letter topic per
 * logical topic (`mode: "per-topic"`) instead of the shared `consume` queue: the pubsub module
 * emits one `queues[...]` entry per physical queue and each gets its own push route.
 */
export default defineStack({
  // Stack names are at most 20 characters (service account ids).
  name: "gcp-fs-per-topic",
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
  queue: pubsubQueue({ projectId, region, mode: "per-topic" }),
  blob: gcsBlob({ location: region }),
  kv: firestoreKv({ projectId, location: region }),
  outputs: {
    ingest_url: output("platform", "ingest_url"),
    api_url: output("platform", "api_url"),
  },
});
