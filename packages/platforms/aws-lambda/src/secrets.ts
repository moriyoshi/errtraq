import { AwsRequestError, awsRequest } from "@moriyoshi/errtraq-aws-signing";
import type { SecretSource } from "@moriyoshi/errtraq-core";

/** Errors never contain the identifier, provider response, or secret value. */
export class SecretReadError extends Error {
  override name = "SecretReadError";
  constructor(
    readonly providerCode?: string,
    readonly retryable = false,
  ) {
    super("Unable to read secret from AWS Secrets Manager");
  }
}
export interface SecretsManagerOptions {
  environment: Readonly<Record<string, string | undefined>>;
  ttlMs?: number;
  now?: () => number;
  fetch?: typeof fetch;
  endpoint?: string;
}
/** Cache is per source instance, normally one instance per Lambda execution environment. */
export function createSecretsManagerSource(
  options: SecretsManagerOptions,
): SecretSource {
  const ttl = options.ttlMs ?? 300_000;
  if (!Number.isSafeInteger(ttl) || ttl < 0)
    throw new RangeError("Invalid secret cache TTL");
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();
  return {
    async read(identifier) {
      if (
        !/^arn:[a-z0-9-]+:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$/.test(
          identifier,
        )
      )
        throw new SecretReadError("InvalidIdentifier");
      const old = cache.get(identifier);
      if (old && old.expiresAt > now()) return old.value;
      const inflight = pending.get(identifier);
      if (inflight) return inflight;
      const task = (async () => {
        try {
          const region = identifier.split(":")[3];
          if (!region) throw new SecretReadError("InvalidIdentifier");
          const endpoint =
            options.endpoint ??
            `https://secretsmanager.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}/`;
          const response = await awsRequest({
            service: "secretsmanager",
            region,
            url: endpoint,
            method: "POST",
            protocol: "json",
            headers: {
              "content-type": "application/x-amz-json-1.1",
              "x-amz-target": "secretsmanager.GetSecretValue",
            },
            body: JSON.stringify({ SecretId: identifier }),
            credentials: () => ({
              accessKeyId: options.environment.AWS_ACCESS_KEY_ID ?? "",
              secretAccessKey: options.environment.AWS_SECRET_ACCESS_KEY ?? "",
              sessionToken: options.environment.AWS_SESSION_TOKEN,
            }),
            fetch: options.fetch,
          });
          const result: unknown = await response.json();
          if (!result || typeof result !== "object")
            throw new SecretReadError("InvalidResponse");
          let value: string;
          if (
            "SecretString" in result &&
            typeof result.SecretString === "string"
          )
            value = result.SecretString;
          else if (
            "SecretBinary" in result &&
            typeof result.SecretBinary === "string" &&
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
              result.SecretBinary,
            )
          )
            value = new TextDecoder("utf-8", { fatal: true }).decode(
              Uint8Array.from(atob(result.SecretBinary), (x) =>
                x.charCodeAt(0),
              ),
            );
          else throw new SecretReadError("InvalidResponse");
          cache.set(identifier, { value, expiresAt: now() + ttl });
          return value;
        } catch (error) {
          if (error instanceof SecretReadError) throw error;
          if (error instanceof AwsRequestError)
            throw new SecretReadError(error.code, error.retryable);
          throw new SecretReadError("InvalidResponse");
        }
      })();
      pending.set(identifier, task);
      try {
        return await task;
      } finally {
        pending.delete(identifier);
      }
    },
  };
}
