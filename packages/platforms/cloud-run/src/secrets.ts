import type { SecretSource } from "@moriyoshi/errtraq-core";
import {
  CLOUD_PLATFORM_SCOPE,
  type Fetch,
  type TokenSource,
} from "@moriyoshi/errtraq-gcp-auth";

/** Errors never contain the identifier, provider response, or secret value. */
export class SecretReadError extends Error {
  override name = "SecretReadError";
  constructor(
    readonly providerCode?: string,
    readonly retryable = false,
  ) {
    super("Unable to read secret from Google Secret Manager");
  }
}
export const SECRET_MANAGER_ENDPOINT = "https://secretmanager.googleapis.com";
/** `projects/<project>/secrets/<id>` (latest) or with an explicit `/versions/<n|latest>`. */
export const SECRET_IDENTIFIER =
  /^projects\/[a-z0-9][a-z0-9-]{0,61}[a-z0-9]\/secrets\/[A-Za-z0-9_-]{1,255}(?:\/versions\/(?:latest|[1-9][0-9]*))?$/;
export interface SecretManagerOptions {
  tokens: Pick<TokenSource, "getAccessToken">;
  ttlMs?: number;
  now?: () => number;
  fetch?: Fetch;
  endpoint?: string;
  timeoutMs?: number;
}
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
/** The versions path of an identifier: `latest` unless the identifier pins a version. */
export function versionResource(identifier: string): string {
  return /\/versions\//.test(identifier)
    ? identifier
    : `${identifier}/versions/latest`;
}
/** Decode the base64 payload of `versions:access` (standard or URL-safe alphabet). */
function decodePayload(data: string): string {
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(data))
    throw new SecretReadError("InvalidResponse");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(
        atob(data.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      ),
    );
  } catch {
    throw new SecretReadError("InvalidResponse");
  }
}
/** Cache is per source instance, normally one instance per container instance. */
export function createSecretManagerSource(
  options: SecretManagerOptions,
): SecretSource {
  const ttl = options.ttlMs ?? 300_000;
  if (!Number.isSafeInteger(ttl) || ttl < 0)
    throw new RangeError("Invalid secret cache TTL");
  const now = options.now ?? Date.now;
  const fetcher = options.fetch ?? fetch;
  const endpoint = (options.endpoint ?? SECRET_MANAGER_ENDPOINT).replace(
    /\/+$/,
    "",
  );
  const cache = new Map<string, { value: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();
  return {
    async read(identifier) {
      if (!SECRET_IDENTIFIER.test(identifier))
        throw new SecretReadError("InvalidIdentifier");
      const old = cache.get(identifier);
      if (old && old.expiresAt > now()) return old.value;
      const inflight = pending.get(identifier);
      if (inflight) return inflight;
      const task = (async () => {
        try {
          const token = await options.tokens.getAccessToken([
            CLOUD_PLATFORM_SCOPE,
          ]);
          const response = await fetcher(
            `${endpoint}/v1/${versionResource(identifier)}:access`,
            {
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
            },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new SecretReadError(
              `HTTP${response.status}`,
              RETRYABLE.has(response.status),
            );
          }
          const result: unknown = await response.json();
          const data =
            result && typeof result === "object" && "payload" in result
              ? (result.payload as { data?: unknown } | null)?.data
              : undefined;
          if (typeof data !== "string")
            throw new SecretReadError("InvalidResponse");
          const value = decodePayload(data);
          cache.set(identifier, { value, expiresAt: now() + ttl });
          return value;
        } catch (error) {
          if (error instanceof SecretReadError) throw error;
          // Token, network and decoding failures carry no provider text on purpose.
          throw new SecretReadError("RequestFailed", true);
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
