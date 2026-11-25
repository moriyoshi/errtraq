import {
  type ActiveStore,
  type BootstrapVault,
  type KV,
  type Logger,
  type RateRejectionConfig,
  type RemoteBootstrapResponse,
  runRemoteBootstrap,
} from "@moriyoshi/errtraq-core/runtime";
import {
  CLOUD_PLATFORM_SCOPE,
  type Fetch,
  type TokenSource,
} from "@moriyoshi/errtraq-gcp-auth";
import { SECRET_MANAGER_ENDPOINT } from "./secrets.js";
import { BOOTSTRAP_SECRET_ENV } from "./stack.js";

/** Secret Manager secret ids; the same rule the module's IAM condition names exactly. */
export const BOOTSTRAP_SECRET_NAME = /^[A-Za-z0-9_-]{1,255}$/;
export const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
/** The one secret id the function's IAM condition allows; absent or malformed is a deployment bug. */
export function bootstrapSecretName(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const name = environment[BOOTSTRAP_SECRET_ENV];
  if (!name || !BOOTSTRAP_SECRET_NAME.test(name))
    throw new Error("Missing or invalid bootstrap secret name binding");
  return name;
}
export interface GcpBootstrapVaultOptions {
  projectId: string;
  tokens: Pick<TokenSource, "getAccessToken">;
  fetch?: Fetch;
  endpoint?: string;
  sleep?: (ms: number) => Promise<void>;
}
/**
 * Secret Manager create-or-read for the bootstrap secret. Secret creation and the first version
 * are two calls (AWS does both in one), so the canonical value is always **version 1**: a caller
 * that finds no version 1 adds its candidate and then reads version 1 back, so concurrent
 * bootstraps converge on whichever candidate became version 1 and the others are discarded. The
 * returned identifier names version 1 (operators read that version; later versions are ignored).
 * Requires `secretmanager.secrets.create`, `secretmanager.versions.add` and
 * `secretmanager.versions.access` on that one secret id (IAM condition, module in G6).
 */
export function gcpBootstrapVault(
  options: GcpBootstrapVaultOptions,
): BootstrapVault {
  if (!PROJECT_ID.test(options.projectId))
    throw new Error("Invalid Google project id");
  const fetcher = options.fetch ?? fetch;
  const endpoint = (options.endpoint ?? SECRET_MANAGER_ENDPOINT).replace(
    /\/+$/,
    "",
  );
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // Only the status leaves this function: provider bodies can echo request data.
  const call = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json?: Record<string, unknown> }> => {
    let response: Response;
    try {
      const token = await options.tokens.getAccessToken([CLOUD_PLATFORM_SCOPE]);
      response = await fetcher(`${endpoint}/v1/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Secret Manager bootstrap operation failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status };
    }
    try {
      const json: unknown = await response.json();
      if (!json || typeof json !== "object" || Array.isArray(json))
        throw new Error();
      return { status: response.status, json: json as Record<string, unknown> };
    } catch {
      throw new Error("Secret Manager bootstrap operation failed");
    }
  };
  const decode = (json: Record<string, unknown> | undefined): string => {
    const data = (json?.payload as { data?: unknown } | undefined)?.data;
    if (typeof data !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(data))
      throw new Error("Unable to read bootstrap secret");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(
          atob(data.replaceAll("-", "+").replaceAll("_", "/")),
          (c) => c.charCodeAt(0),
        ),
      );
    } catch {
      throw new Error("Unable to read bootstrap secret");
    }
  };
  return {
    async claim(name, candidate) {
      if (!BOOTSTRAP_SECRET_NAME.test(name))
        throw new Error("Invalid bootstrap secret name");
      const secret = `projects/${options.projectId}/secrets/${name}`;
      const first = `${secret}/versions/1`;
      const created = await call(
        "POST",
        `projects/${options.projectId}/secrets?secretId=${encodeURIComponent(name)}`,
        { replication: { automatic: {} } },
      );
      // 409: another caller (or an earlier attempt) created the secret.
      if (created.status !== 200 && created.status !== 409)
        throw new Error("Unable to create bootstrap secret");
      for (let attempt = 0; attempt < 8; attempt++) {
        const read = await call("GET", `${first}:access`);
        if (read.status === 200)
          return { identifier: first, value: decode(read.json) };
        if (read.status !== 404 && read.status !== 400)
          throw new Error("Unable to read bootstrap secret");
        // No version 1 yet (or it is not enabled): add ours and read version 1 back.
        const added = await call("POST", `${secret}:addVersion`, {
          payload: {
            data: btoa(
              String.fromCharCode(...new TextEncoder().encode(candidate)),
            ),
          },
        });
        if (added.status === 200) {
          const read = await call("GET", `${first}:access`);
          if (read.status !== 200)
            throw new Error("Unable to read bootstrap secret");
          const value = decode(read.json);
          const won = (added.json?.name as string | undefined)?.endsWith(
            "/versions/1",
          );
          return {
            identifier: first,
            value,
            ...(won && value === candidate ? { created: true } : {}),
          };
        }
        await sleep(Math.random() * Math.min(500, 25 * 2 ** attempt));
      }
      throw new Error("Unable to read bootstrap secret");
    },
  };
}
export interface BootstrapHandlerOptions {
  stackName: string;
  store: ActiveStore;
  kv: KV;
  vault: BootstrapVault;
  /** Fixed by the deployment (see {@link bootstrapSecretName}); the invoker cannot choose it. */
  secretName: string;
  retentionDays?: number;
  maxRetentionDays?: number;
  rateRejection?: RateRejectionConfig;
  logger?: Pick<Logger, "info" | "error">;
}
/**
 * Handler of the operator-invoked bootstrap service. The body is the request document
 * (non-secret options only); the result is a non-secret summary or a scrubbed error document.
 * The DSN and API token go to the bootstrap secret and are never returned or logged.
 * The response field `secret.arn` carries the Secret Manager version resource name.
 */
export function createBootstrapHandler(
  options: BootstrapHandlerOptions,
): (body: unknown) => Promise<RemoteBootstrapResponse> {
  return (body) => runRemoteBootstrap(body, options);
}
