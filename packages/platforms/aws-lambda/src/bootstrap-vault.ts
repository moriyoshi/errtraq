import { AwsRequestError, awsRequest } from "@moriyoshi/errtraq-aws-signing";
import type { BootstrapVault } from "@moriyoshi/errtraq-core/runtime";
import { createSecretsManagerSource, SecretReadError } from "./secrets.js";

/**
 * Secrets Manager create-or-read for the bootstrap secret. The winner of CreateSecret writes the
 * DSN and first token; every other caller reads that value, so concurrent bootstraps converge.
 * Shared by the operator CLI and the deployed bootstrap function.
 */
export function awsBootstrapVault(
  environment: Readonly<Record<string, string | undefined>>,
  fetcher?: typeof fetch,
): BootstrapVault {
  const region = environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION;
  if (!region) throw new Error("Missing AWS region");
  const source = createSecretsManagerSource({
    environment,
    fetch: fetcher,
    ttlMs: 0,
  });
  const request = async (
    action: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    try {
      const response = await awsRequest({
        service: "secretsmanager",
        region,
        url: `https://secretsmanager.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}/`,
        method: "POST",
        protocol: "json",
        headers: {
          "content-type": "application/x-amz-json-1.1",
          "x-amz-target": `secretsmanager.${action}`,
        },
        body: JSON.stringify(input),
        credentials: () => ({
          accessKeyId: environment.AWS_ACCESS_KEY_ID ?? "",
          secretAccessKey: environment.AWS_SECRET_ACCESS_KEY ?? "",
          sessionToken: environment.AWS_SESSION_TOKEN,
        }),
        fetch: fetcher,
      });
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      return value as Record<string, unknown>;
    } catch (error) {
      if (
        error instanceof AwsRequestError &&
        (error.code === "ResourceExistsException" ||
          error.code === "ResourceNotFoundException")
      )
        throw error;
      throw new Error("Secrets Manager bootstrap operation failed");
    }
  };
  return {
    async claim(name, candidate) {
      try {
        const created = await request("CreateSecret", {
          Name: name,
          SecretString: candidate,
          ClientRequestToken: crypto.randomUUID(),
        });
        if (typeof created.ARN !== "string")
          throw new Error("Invalid secret ARN");
        return { identifier: created.ARN, value: candidate, created: true };
      } catch (error) {
        if (
          !(error instanceof AwsRequestError) ||
          error.code !== "ResourceExistsException"
        )
          throw new Error("Unable to create bootstrap secret");
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const description = await request("DescribeSecret", {
            SecretId: name,
          });
          if (typeof description.ARN !== "string")
            throw new Error("Invalid secret ARN");
          return {
            identifier: description.ARN,
            value: await source.read(description.ARN),
          };
        } catch (error) {
          const missing =
            error instanceof AwsRequestError
              ? error.code === "ResourceNotFoundException"
              : error instanceof SecretReadError &&
                error.providerCode === "ResourceNotFoundException";
          if (!missing || attempt === 7)
            throw new Error("Unable to read bootstrap secret");
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.random() * Math.min(500, 25 * 2 ** attempt),
            ),
          );
        }
      }
      throw new Error("Unable to read bootstrap secret");
    },
  };
}
