import { defineStack, output, variable } from "@moriyoshi/errtraq-core";
import { cloudRun } from "@moriyoshi/errtraq-platform-cloud-run/stack";
import { IMAGE_VARIABLE, requiredEnv } from "./gcp-env.ts";
import base from "./gcp-firestore.ts";

const projectId = requiredEnv("ERRTRAQ_GCP_PROJECT");
const region = requiredEnv("ERRTRAQ_GCP_REGION");
/** An IAM member such as `user:operator@example.com`; there is no default, nobody is assumed to be the operator. */
const operator = requiredEnv("ERRTRAQ_GCP_OPERATOR_MEMBER");

/**
 * The Firestore stack plus the optional `bootstrap` role: a private Cloud Run service that
 * migrates, bootstraps and writes the bootstrap secret to Secret Manager from inside the stack
 * (`errtraq bootstrap --remote --service-url <bootstrap_url>`). Only `operator` may invoke it.
 * Direct recording keeps the role list explicit.
 */
export default defineStack({
  ...(Object.fromEntries(Object.entries(base)) as typeof base),
  // Stack names are at most 20 characters (service account ids).
  name: "gcp-fs-bootstrap",
  recordMode: "direct",
  platform: cloudRun({
    projectId,
    region,
    image: variable(IMAGE_VARIABLE),
    roles: ["ingest", "api", "consumer", "cron", "bootstrap"],
    bootstrapSecretName: "errtraq-bootstrap-gcp-firestore",
    operatorMembers: [operator],
  }),
  outputs: {
    ingest_url: output("platform", "ingest_url"),
    api_url: output("platform", "api_url"),
    bootstrap_url: output("platform", "bootstrap_url"),
  },
});
