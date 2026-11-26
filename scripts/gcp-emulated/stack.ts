import { gcsBlob } from "@moriyoshi/errtraq-blob-gcs/stack";
import { defineStack } from "@moriyoshi/errtraq-core";
import { firestoreKv } from "@moriyoshi/errtraq-kv-firestore/stack";
import { cloudRun } from "@moriyoshi/errtraq-platform-cloud-run/stack";
import { pubsubQueue } from "@moriyoshi/errtraq-queue-pubsub/stack";
import { firestoreStore } from "@moriyoshi/errtraq-store-firestore/stack";

/**
 * Test-only stack of `pnpm test:gcp-emulated`: the Cloud Run platform wired to the Firestore,
 * Pub/Sub and GCS emulators. Never deployed (its Pub/Sub push authentication is off, which the
 * adapter refuses on Cloud Run and without a loopback emulator). The GCS emulator origin is
 * read at build time, because the blob adapter takes its endpoint from configuration.
 */
const gcsEndpoint = process.env.ERRTRAQ_GCP_EMULATOR_GCS_ENDPOINT;
if (!gcsEndpoint)
  throw new Error("ERRTRAQ_GCP_EMULATOR_GCS_ENDPOINT is set by the harness");
const projectId = "errtraq-test";
const region = "europe-west1";

export default defineStack({
  name: "gcp-emulated",
  providers: {
    google: {
      source: "hashicorp/google",
      version: "~> 8.0",
      project: projectId,
      region,
    },
  },
  recordMode: "direct",
  platform: cloudRun({
    projectId,
    region,
    image: `registry.example/errtraq/app@sha256:${"a".repeat(64)}`,
    // One function hosts every role: a single process to start and to push to.
    roles: ["ingest", "api", "consumer", "cron"],
    split: [],
    // Absent limit: the e2e sends a handful of events.
    rateLimit: null,
  }),
  store: firestoreStore({ projectId, location: region }),
  queue: pubsubQueue({
    projectId,
    region,
    mode: "shared",
    pushAuth: "none",
    // Only the emulator host (PUBSUB_EMULATOR_HOST) decides where the queue talks to.
  }),
  blob: gcsBlob({
    location: region,
    auth: { mode: "none" },
    endpoint: gcsEndpoint,
  }),
  kv: firestoreKv({ projectId, location: region }),
});
