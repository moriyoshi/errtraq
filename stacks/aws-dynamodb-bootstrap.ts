import { defineStack, output } from "@moriyoshi/errtraq-core";
import { awsLambda } from "@moriyoshi/errtraq-platform-aws-lambda/stack";
import base from "./aws-dynamodb.js";

/**
 * The DynamoDB stack plus the optional `bootstrap` role: an operator-invoked function that
 * migrates, bootstraps and writes the bootstrap secret from inside the stack's network
 * (`errtraq bootstrap --remote`). Direct recording keeps the role list explicit.
 */
export default defineStack({
  ...(Object.fromEntries(Object.entries(base)) as typeof base),
  name: "aws-dynamodb-bootstrap",
  recordMode: "direct",
  platform: awsLambda({
    roles: ["ingest", "api", "consumer", "cron", "bootstrap"],
    bootstrapSecretName: "errtraq/bootstrap/aws-dynamodb",
  }),
  outputs: {
    ingest_url: output("platform", "ingest_url"),
    api_url: output("platform", "api_url"),
    bootstrap_function_name: output("platform", "bootstrap_function_name"),
  },
});
